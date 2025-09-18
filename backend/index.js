import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(cors())
app.use(express.json())

// Future: serve static MassGIS/GTFS artifacts from /static
app.use('/static', express.static(path.join(__dirname, 'static')))

app.get('/healthz', (_req, res) => res.send('ok'))
app.get('/api/version', (_req, res) => res.json({ version: '0.0.1' }))

const port = process.env.PORT || 3000
app.listen(port, () => console.log(`Backend listening on port ${port}`))