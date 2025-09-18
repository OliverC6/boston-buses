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

const MASSGIS_SERVICE_URL =
    'https://services.massgis.digital.mass.gov/arcgis/rest/services/Transportation/MBTA_Bus/MapServer'
const DEFAULT_PAGE_SIZE = 1000
const CACHE_TTL_MS = 15 * 60 * 1000

const layerCache = new Map()

async function fetchLayerPage(layerId, offset, pageSize) {
    const params = new URLSearchParams({
        where: '1=1',
        outFields: '*',
        f: 'json',
        outSR: '4326',
        resultOffset: String(offset),
        resultRecordCount: String(pageSize),
        orderByFields: 'OBJECTID'
    })

    const response = await fetch(`${MASSGIS_SERVICE_URL}/${layerId}/query?${params.toString()}`)

    if (!response.ok) {
        const message = await response.text()
        throw new Error(`MassGIS layer ${layerId} request failed: ${response.status} ${message}`)
    }

    return response.json()
}

function sanitizeCoordinatePair(candidate) {
    if (!Array.isArray(candidate) || candidate.length < 2) return null

    const [x, y] = candidate

    if (typeof x !== 'number' || typeof y !== 'number') return null

    return [x, y]
}

function convertArcGisGeometryToGeoJson(geometry) {
    if (!geometry) return null

    if (typeof geometry.x === 'number' && typeof geometry.y === 'number') {
        return {
            type: 'Point',
            coordinates: [geometry.x, geometry.y]
        }
    }

    if (Array.isArray(geometry.paths)) {
        const sanitizedPaths = geometry.paths
            .map((path) =>
                Array.isArray(path)
                    ? path
                          .map((vertex) => sanitizeCoordinatePair(vertex))
                          .filter((vertex) => vertex !== null)
                    : []
            )
            .filter((path) => path.length > 0)

        if (sanitizedPaths.length === 0) return null

        if (sanitizedPaths.length === 1) {
            return {
                type: 'LineString',
                coordinates: sanitizedPaths[0]
            }
        }

        return {
            type: 'MultiLineString',
            coordinates: sanitizedPaths
        }
    }

    if (Array.isArray(geometry.rings)) {
        const sanitizedRings = geometry.rings
            .map((ring) =>
                Array.isArray(ring)
                    ? ring
                          .map((vertex) => sanitizeCoordinatePair(vertex))
                          .filter((vertex) => vertex !== null)
                    : []
            )
            .filter((ring) => ring.length > 3)

        if (sanitizedRings.length === 0) return null

        if (sanitizedRings.length === 1) {
            return {
                type: 'Polygon',
                coordinates: sanitizedRings
            }
        }

        return {
            type: 'MultiPolygon',
            coordinates: sanitizedRings.map((ring) => [ring])
        }
    }

    return null
}

function convertArcGisFeatureToGeoJson(feature) {
    if (!feature) return null

    const properties = feature.attributes ?? feature.properties ?? {}
    const geometry = convertArcGisGeometryToGeoJson(feature.geometry)

    if (!geometry) return null

    const id = properties.OBJECTID ?? feature.objectId ?? feature.id ?? undefined

    return {
        type: 'Feature',
        id,
        properties,
        geometry
    }
}

async function fetchLayerFeatures(layerId, pageSize = DEFAULT_PAGE_SIZE) {
    const numericLayerId = Number(layerId)

    if (!Number.isFinite(numericLayerId) || numericLayerId < 0) {
        throw new Error('Invalid layer id')
    }

    const cacheKey = String(numericLayerId)
    const cached = layerCache.get(cacheKey)

    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.data
    }

    const features = []
    let offset = 0

    while (true) {
        const payload = await fetchLayerPage(numericLayerId, offset, pageSize)
        const pageFeatures = Array.isArray(payload.features) ? payload.features : []

        features.push(...pageFeatures)

        const exceeded = payload.exceededTransferLimit === true
        const hasFullPage = pageFeatures.length === pageSize

        if ((!exceeded && !hasFullPage) || pageFeatures.length === 0) {
            break
        }

        offset += pageFeatures.length
    }

    const geoJson = {
        type: 'FeatureCollection',
        features: features
            .map((feature) => convertArcGisFeatureToGeoJson(feature))
            .filter((feature) => feature !== null)
    }

    layerCache.set(cacheKey, { data: geoJson, timestamp: Date.now() })

    return geoJson
}

app.get('/api/massgis/layers/:layerId', async (req, res) => {
    try {
        const layerId = req.params.layerId
        const data = await fetchLayerFeatures(layerId)
        res.json(data)
    } catch (error) {
        console.error('Failed to load MassGIS layer', error)
        res.status(502).json({ error: 'Failed to load MassGIS layer', details: error.message })
    }
})

const port = process.env.PORT || 3000
app.listen(port, () => console.log(`Backend listening on port ${port}`))