const path = require('node:path')
const downloadSOS = require('../index.js')

require('dotenv').config({
	path: path.resolve(__dirname, '..', '.env')
})

async function run() {
	const result = await downloadSOS({
		database: {
			engine: process.env.SQLITE_ENGINE,
			filename: process.env.SQLITE_FILENAME
		},
		sosAuthorization: process.env.SOS_AUTH,
		retries: 5
	})

	if (!result.ok) {
		console.error('downloadSOS failed:', result.error)
		process.exitCode = 1
	} else {
		console.log('downloadSOS completed successfully')
	}
}

run()
