var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var require_index = __commonJS({
  "index.js"(exports, module) {
    const openDb = require("./db/database.js");
    const createTable = require("./db/create-table.js");
    const insertRow = require("./db/insert-row.js");
    const { tables, supportTables } = require("./db/definitions.js");
    function formatRuntime(ms) {
      const totalSeconds = Math.floor(ms / 1e3);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor(totalSeconds % 3600 / 60);
      const seconds = totalSeconds % 60;
      return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    }
    async function sosApi(url, method, authorization, retries = 5) {
      console.log(url);
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const res = await fetch(url, {
            method,
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              Accept: "*/*",
              "Accept-Encoding": "gzip, deflate, br",
              "Content-Type": "application/x-www-form-urlencoded",
              Host: "api.sosinventory.com",
              Authorization: authorization
            }
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`);
          }
          return await res.json();
        } catch (err) {
          if (attempt === retries) throw err;
          const delay = 250 * attempt;
          console.log(`Retry ${attempt}/${retries} after error: ${err.message}`);
          console.log(url);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    async function downloadTable(params, engine, table) {
      const ctResult = await createTable(engine, table);
      if (!ctResult.ok) return ctResult;
      const retries = params.retries ?? 5;
      let offset = 1;
      await engine.begin();
      while (true) {
        const result = await sosApi(
          `https://api.sosinventory.com${table.api.query.endpoint}?start=${offset}&maxresults=200`,
          table.api.query.method,
          params.sosAuthorization,
          retries
        );
        if (result.status !== "ok") {
          await engine.rollback();
          return { ok: false, message: result.message || "SOS API returned non-ok status" };
        }
        if (!Array.isArray(result.data)) {
          await engine.rollback();
          return { ok: false, message: "SOS API returned invalid data array" };
        }
        if (typeof result.count !== "number" || typeof result.totalCount !== "number") {
          await engine.rollback();
          return { ok: false, message: "SOS API returned invalid pagination fields" };
        }
        for (const record of result.data) {
          delete record.keys;
          delete record.values;
          const irResult = await insertRow(engine, table, record);
          if (!irResult.ok) {
            await engine.rollback();
            return { ok: false, message: irResult };
          }
        }
        offset += result.count;
        if (offset > result.totalCount) break;
      }
      await engine.commit();
      return { ok: true };
    }
    async function handleSupportTable(engine, table) {
      await createTable(engine, table);
      const supportMap = /* @__PURE__ */ new Map();
      for (const sourceTable of table.sourceTables) {
        const rows = await engine.query(
          `SELECT DISTINCT ${engine.q(table.sourceField)} FROM ${engine.q(sourceTable)} WHERE ${engine.q(table.sourceField)} IS NOT NULL`,
          [],
          true
        );
        for (const row of rows) {
          let obj;
          try {
            obj = row[table.sourceField];
            if (typeof obj !== "object") obj = JSON.parse(obj);
          } catch (err) {
            console.error(`Invalid JSON in ${table.name}:`, row[table.sourceField]);
            continue;
          }
          if (!obj || typeof obj !== "object") continue;
          const key = obj.id ?? obj.value ?? obj.code ?? obj.name;
          if (!key) continue;
          if (!supportMap.has(key)) {
            supportMap.set(key, {
              id: obj.id ?? obj.value ?? obj.code,
              name: obj.name ?? obj.code ?? obj.value
            });
          }
        }
      }
      for (const value of supportMap.values()) {
        await insertRow(engine, table, value);
      }
      return { ok: true };
    }
    async function handleItemBoms(params, engine, table) {
      await createTable(engine, table);
      const items = await engine.query("select id from items where type IN ('Assembly', 'Item Group')", [], true);
      const retries = params.retries ?? 5;
      for (const item of items) {
        const result = await sosApi(`https://api.sosinventory.com/api/v2/item/${item.id}/bom`, "GET", params.sosAuthorization, retries);
        if (!result.data) continue;
        if (result.data.lines.length === 0) continue;
        const lines = result.data.lines;
        for (const line of lines) {
          const id = Number(line.lineId);
          delete line.lineId;
          const record = {
            id,
            itemId: item.id,
            ...line
          };
          await insertRow(engine, table, record);
        }
      }
      return { ok: true };
    }
    async function downloadSOS(params) {
      if (!params.database.engine) {
        return {
          ok: false,
          message: "Missing required parameter: params.database.engine",
          error: new Error("params.database.engine is required"),
          extra: null
        };
      }
      if (!params.sosAuthorization) {
        return {
          ok: false,
          message: "Missing required parameter: params.sosAuthorization",
          error: new Error("params.sosAuthorization is required"),
          extra: null
        };
      }
      const start = Date.now();
      const engine = await openDb(params.database);
      const referenceTables = tables.filter((table) => table.reference === true);
      for (const table of referenceTables) {
        const result = await downloadTable(params, engine, table);
        if (!result.ok) {
          if (engine.close) await engine.close();
          return {
            ok: false,
            message: `downloadTable failed for ${table.name}`,
            error: result.error || new Error("Unknown downloadTable error"),
            extra: { table: table.name, result }
          };
        }
      }
      const primaryTables = tables.filter((table) => table.primary === true);
      for (const table of primaryTables) {
        const result = await downloadTable(params, engine, table);
        if (!result.ok) {
          if (engine.close) await engine.close();
          return {
            ok: false,
            message: `downloadTable failed for ${table.name}`,
            error: result.error || new Error("Unknown downloadTable error"),
            extra: { table: table.name, result }
          };
        }
      }
      for (const table of supportTables) {
        if (table.name === "itemBoms") {
          const bomResult = await handleItemBoms(params, engine, table);
          if (!bomResult.ok) {
            if (engine.close) await engine.close();
            return {
              ok: false,
              message: "handleItemBoms failed",
              error: bomResult.error || new Error("Unknown item BOM handler error"),
              extra: { table: table.name, result: bomResult }
            };
          }
        } else {
          const refResult = await handleSupportTable(engine, table);
          if (!refResult.ok) {
            if (engine.close) await engine.close();
            return {
              ok: false,
              message: "handleSupportTable failed",
              error: refResult.error || new Error("Unknown support table handler error"),
              extra: { table: table.name, result: refResult }
            };
          }
        }
      }
      if (engine.close) await engine.close();
      const runtime = formatRuntime(Date.now() - start);
      return {
        ok: true,
        message: "downloadSOS completed successfully",
        error: null,
        extra: { runtime }
      };
    }
    module.exports = downloadSOS;
  }
});
export default require_index();
