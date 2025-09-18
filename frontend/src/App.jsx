import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

const MBTA_API_KEY =
    typeof import.meta.env.VITE_MBTA_API_KEY === 'string'
        ? import.meta.env.VITE_MBTA_API_KEY.trim()
        : ''

const MBTA_REQUEST_HEADERS = MBTA_API_KEY
    ? { accept: 'application/vnd.api+json', 'x-api-key': MBTA_API_KEY }
    : { accept: 'application/vnd.api+json' }

// Data
const EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] }

// Layer Configs
const STOP_LAYER = {
    arcgisLayerId: 0,
    sourceId: 'bus-stops-source',
    layerId: 'bus-stops-layer',
    minzoom: 13.5,
    maxzoom: 24,
    circle: {
        radius: [
            'interpolate',
            ['linear'],
            ['zoom'],
            13.5,
            3.2,
            15.4,
            3.9,
            17.2,
            4.6
        ],
        color: '#1f7bf6',
        opacity: 0.7,
        strokeWidth: 0.6,
        strokeColor: '#ffffff'
    }
}

// Colors
const COLOR_PALETTE = [
    '#e74c3c',
    '#27ae60',
    '#2980b9',
    '#8e44ad',
    '#f39c12',
    '#16a085',
    '#d35400',
    '#2c3e50',
    '#c0392b',
    '#9b59b6',
    '#1abc9c',
    '#34495e'
]

// Helper Functions
function getRouteColor(routeId) {
    if (!routeId) return '#555555'

    let hash = 0
    for (let index = 0; index < routeId.length; index += 1) {
        hash = routeId.charCodeAt(index) + ((hash << 5) - hash)
        hash &= hash
    }

    const paletteIndex = Math.abs(hash) % COLOR_PALETTE.length
    return COLOR_PALETTE[paletteIndex]
}

function normalizeRouteFeature(feature, index) {
    if (!feature || !feature.geometry) return null

    const properties = feature.properties ?? {}

    const routeNumberSource =
        properties.route_num !== undefined && properties.route_num !== null
            ? properties.route_num
            : properties.route_id
    const routeNameSource =
        properties.route_desc !== undefined && properties.route_desc !== null
            ? properties.route_desc
            : properties.name

    const routeNumber =
        routeNumberSource !== undefined && routeNumberSource !== null
            ? String(routeNumberSource).trim()
            : ''
    const routeName =
        routeNameSource !== undefined && routeNameSource !== null
            ? String(routeNameSource).trim()
            : ''

    const fallbackIdParts = []
    if (routeNumber) {
        fallbackIdParts.push(routeNumber)
    }

    const fallbackId = fallbackIdParts.join('-') || feature.id || properties.FID || `route-${index}`
    const featureId = feature.id ?? properties.SHAPE_ID ?? properties.FID ?? fallbackId
    const routeId = routeNumber || fallbackId
    const displayName = routeName || (routeNumber ? `Route ${routeNumber}` : 'MBTA Bus Route')

    return {
        ...feature,
        id: featureId,
        properties: {
            ...properties,
            route_id: routeId,
            name: displayName,
            color: getRouteColor(routeId)
        }
    }
}

function normalizeStopFeature(stop, index) {
    if (!stop) return null

    const attributes = stop.attributes ?? {}
    const latitude = Number(attributes.latitude)
    const longitude = Number(attributes.longitude)

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null
    }

    const trimmedName = typeof attributes.name === 'string' ? attributes.name.trim() : ''
    const fallbackName = trimmedName || 'MBTA Stop'

    return {
        type: 'Feature',
        id: stop.id ?? `stop-${index}`,
        geometry: {
            type: 'Point',
            coordinates: [longitude, latitude]
        },
        properties: {
            name: fallbackName,
            description: typeof attributes.description === 'string' ? attributes.description.trim() : '',
            municipality: typeof attributes.municipality === 'string' ? attributes.municipality.trim() : '',
            wheelchair_boarding: attributes.wheelchair_boarding,
            platform_code: typeof attributes.platform_code === 'string' ? attributes.platform_code.trim() : '',
            on_street: typeof attributes.on_street === 'string' ? attributes.on_street.trim() : '',
            at_street: typeof attributes.at_street === 'string' ? attributes.at_street.trim() : ''
        }
    }
}

function getErrorMessage(error, fallbackMessage) {
    if (error instanceof Error) return error.message
    if (typeof error === 'string' && error.trim() !== '') return error
    return fallbackMessage
}

function decodePolyline(encoded) {
    if (typeof encoded !== 'string' || encoded.length === 0) {
        return []
    }

    const coordinates = []
    let index = 0
    let latitude = 0
    let longitude = 0

    while (index < encoded.length) {
        let result = 0
        let shift = 0
        let byte

        do {
            if (index >= encoded.length) {
                return coordinates
            }

            byte = encoded.charCodeAt(index++) - 63
            result |= (byte & 0x1f) << shift
            shift += 5
        } while (byte >= 0x20)

        const deltaLat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1
        latitude += deltaLat

        result = 0
        shift = 0

        do {
            if (index >= encoded.length) {
                return coordinates
            }

            byte = encoded.charCodeAt(index++) - 63
            result |= (byte & 0x1f) << shift
            shift += 5
        } while (byte >= 0x20)

        const deltaLng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1
        longitude += deltaLng

        const lat = latitude / 1e5
        const lng = longitude / 1e5

        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            coordinates.push([lng, lat])
        }
    }

    return coordinates
}

// Async Functions
async function fetchMbtaRouteMetadata() {
    const routes = new Map()
    const url = new URL('https://api-v3.mbta.com/routes')
    const pageLimit = 200
    let pageOffset = 0

    while (true) {
        url.searchParams.set('filter[type]', '3')
        url.searchParams.set('page[limit]', String(pageLimit))
        url.searchParams.set('page[offset]', String(pageOffset))
        url.searchParams.set('sort', 'short_name')

        const response = await fetch(url.toString(), {
            cache: 'no-cache',
            headers: MBTA_REQUEST_HEADERS
        })

        if (!response.ok) {
            const message = await response.text()
            throw new Error(`request failed with status ${response.status}: ${message}`)
        }

        const payload = await response.json()

        if (!payload || !Array.isArray(payload.data)) {
            throw new Error('unexpected response format from MBTA routes API')
        }

        for (const item of payload.data) {
            if (!item || typeof item !== 'object') continue

            const routeId = item.id
            if (!routeId) continue

            const attributes = item.attributes ?? {}
            const shortName =
                typeof attributes.short_name === 'string' ? attributes.short_name.trim() : ''
            const longName =
                typeof attributes.long_name === 'string' ? attributes.long_name.trim() : ''
            const description =
                typeof attributes.description === 'string' ? attributes.description.trim() : ''

            routes.set(routeId, {
                id: routeId,
                shortName,
                longName,
                description
            })
        }

        const hasNextPage = Boolean(payload.links?.next)

        if (!hasNextPage || payload.data.length < pageLimit) {
            break
        }

        pageOffset += pageLimit

        if (pageOffset > 10000) {
            throw new Error('pagination limit exceeded while loading MBTA routes')
        }
    }

    return routes
}

async function fetchMbtaShapesForRoutes(routeIds, shapesByRoute, routeMetadata) {
    if (!Array.isArray(routeIds) || !routeIds.length) {
        return
    }

    const validRouteIds = routeIds
        .map((routeId) => (typeof routeId === 'string' ? routeId.trim() : ''))
        .filter(Boolean)

    if (!validRouteIds.length) {
        return
    }

    const pageLimit = 500
    let pageOffset = 0

    while (true) {
        url.searchParams.set('filter[type]', '3')
        url.searchParams.set('page[limit]', String(pageLimit))
        url.searchParams.set('page[offset]', String(pageOffset))
        url.searchParams.set('include', 'route')

        const response = await fetch(url.toString(), {
            cache: 'no-cache',
            headers: MBTA_REQUEST_HEADERS
        })

        if (!response.ok) {
            const message = await response.text()
            throw new Error(`request failed with status ${response.status}: ${message}`)
        }

        const payload = await response.json()

        if (!payload || !Array.isArray(payload.data)) {
            throw new Error('unexpected response format from MBTA shapes API')
        }

        for (const item of payload.data) {
            if (!item || typeof item !== 'object') continue

            const routeId = item.relationships?.route?.data?.id
            if (!routeId) continue

            const attributes = item.attributes ?? {}
            const polyline = typeof attributes.polyline === 'string' ? attributes.polyline : ''
            if (!polyline) continue

            const coordinates = decodePolyline(polyline)
            if (coordinates.length < 2) continue

            const existing = shapesByRoute.get(routeId)

            if (existing) {
                existing.push(coordinates)
            } else {
                shapesByRoute.set(routeId, [coordinates])
            }
        }

        if (Array.isArray(payload.included)) {
            for (const includedItem of payload.included) {
                if (!includedItem || includedItem.type !== 'route') continue

                const routeId = includedItem.id
                if (!routeId || routeMetadata.has(routeId)) continue

                const attributes = includedItem.attributes ?? {}
                const shortName =
                    typeof attributes.short_name === 'string' ? attributes.short_name.trim() : ''
                const longName =
                    typeof attributes.long_name === 'string' ? attributes.long_name.trim() : ''
                const description =
                    typeof attributes.description === 'string' ? attributes.description.trim() : ''

                routeMetadata.set(routeId, {
                    id: routeId,
                    shortName,
                    longName,
                    description
                })
            }
        }

        const hasNextPage = Boolean(payload.links?.next)

        if (!hasNextPage || payload.data.length < pageLimit) {
            break
        }

        pageOffset += pageLimit

        if (pageOffset > 100000) {
            throw new Error('pagination limit exceeded while loading MBTA shapes')
        }
    }
}

async function fetchMbtaRoutes() {
    const routeMetadata = await fetchMbtaRouteMetadata()
    const routeIds = Array.from(routeMetadata.keys())

    if (!routeIds.length) {
        throw new Error('no bus routes returned from the MBTA API')
    }

    const shapesByRoute = new Map()
    const batchSize = 25

    for (let index = 0; index < routeIds.length; index += batchSize) {
        const batch = routeIds.slice(index, index + batchSize)
        await fetchMbtaShapesForRoutes(batch, shapesByRoute, routeMetadata)
    }

    if (!shapesByRoute.size) {
        throw new Error('no bus route shapes returned from the MBTA API')
    }

    const features = []
    let index = 0

    for (const [routeId, segments] of shapesByRoute.entries()) {
        const cleanedSegments = segments
            .map((segment) => {
                if (!Array.isArray(segment)) return []

                const cleaned = []

                for (const coordinate of segment) {
                    if (!Array.isArray(coordinate) || coordinate.length !== 2) continue

                    const [lng, lat] = coordinate

                    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue

                    if (cleaned.length) {
                        const [prevLng, prevLat] = cleaned[cleaned.length - 1]

                        if (prevLng === lng && prevLat === lat) {
                            continue
                        }
                    }

                    cleaned.push([lng, lat])
                }

                return cleaned
            })
            .filter((segment) => segment.length >= 2)

        if (!cleanedSegments.length) continue

        const geometry =
            cleanedSegments.length === 1
                ? { type: 'LineString', coordinates: cleanedSegments[0] }
                : { type: 'MultiLineString', coordinates: cleanedSegments }

        const metadata = routeMetadata.get(routeId) ?? {}
        const routeNumber = metadata.shortName || routeId
        const routeName =
            metadata.longName ||
            metadata.description ||
            (routeNumber && routeNumber !== routeId ? `Route ${routeNumber}` : `Route ${routeId}`)

        const normalized = normalizeRouteFeature(
            {
                type: 'Feature',
                id: routeId,
                geometry,
                properties: {
                    route_num: routeNumber,
                    route_desc: routeName,
                    mbta_route_id: routeId
                }
            },
            index
        )

        if (normalized) {
            features.push(normalized)
            index += 1
        }
    }

    if (!features.length) {
        throw new Error('no usable bus routes returned from the MBTA API')
    }

    return { type: 'FeatureCollection', features }
}

async function fetchMbtaStops() {
    const stops = []
    const url = new URL('https://api-v3.mbta.com/stops')
    const pageLimit = 1000
    let pageOffset = 0

    while (true) {
        url.searchParams.set('page[limit]', String(pageLimit))
        url.searchParams.set('page[offset]', String(pageOffset))
        url.searchParams.set('filter[route_type]', '3')
        url.searchParams.set('sort', 'name')

        const response = await fetch(url.toString(), {
            cache: 'no-cache',
            headers: MBTA_REQUEST_HEADERS
        })

        if (!response.ok) {
            const message = await response.text()
            throw new Error(`request failed with status ${response.status}: ${message}`)
        }

        const payload = await response.json()

        if (!payload || !Array.isArray(payload.data)) {
            throw new Error('unexpected response format from MBTA stops API')
        }

        const pageFeatures = payload.data
            .map((item, index) => normalizeStopFeature(item, pageOffset + index))
            .filter(Boolean)

        stops.push(...pageFeatures)

        const hasNextPage = Boolean(payload.links?.next)

        if (!hasNextPage || payload.data.length < pageLimit) {
            break
        }

        pageOffset += pageLimit

        if (pageOffset > 100000) {
            throw new Error('pagination limit exceeded while loading MBTA stops')
        }
    }

    if (!stops.length) {
        throw new Error('no bus stops returned from the MBTA API')
    }

    const featureCollection = { type: 'FeatureCollection', features: stops }

    if (!STOP_LAYER || typeof STOP_LAYER !== 'object') {
        throw new Error('Invalid stop layer configuration')
    }

    const { sourceId } = STOP_LAYER

    if (!sourceId) {
        throw new Error('Stop layer is missing a source ID')
    }

    return { [sourceId]: featureCollection }
}

// Component
export default function App() {
    // Refs
    const mapContainer = useRef(null)
    const mapRef = useRef(null)
    const popupRef = useRef(null)
    const hoveredRouteRef = useRef(null)
    const mapReadyRef = useRef(false)
    const selectedRouteIdRef = useRef(null)

    // States
    const [routesData, setRoutesData] = useState(EMPTY_GEOJSON)
    const [stopData, setStopData] = useState({})
    const [selectedRouteId, setSelectedRouteId] = useState(null)
    const [mapIsReady, setMapIsReady] = useState(false)
    const [isFetchingData, setIsFetchingData] = useState(false)
    const [dataError, setDataError] = useState(null)
    const [stopDataError, setStopDataError] = useState(null)

    // Memos
    const legendItems = useMemo(
        () =>
            routesData.features
                .slice()
                .sort((a, b) => {
                    const aCode = a.properties?.route_id || ''
                    const bCode = b.properties?.route_id || ''
                    return aCode.localeCompare(bCode, undefined, { numeric: true, sensitivity: 'base' })
                })
                .map((feature) => ({
                id: feature.id,
                code: feature.properties.route_id,
                name: feature.properties.name,
                color: feature.properties.color,
                isSelected: feature.id === selectedRouteId,
            })),
        [routesData, selectedRouteId]
    )

    const stopCount = useMemo(() => {
        if (!stopData) return 0
        const sourceId = STOP_LAYER?.sourceId
        if (!sourceId) return 0
        const collection = stopData[sourceId]
        if (!collection || !Array.isArray(collection.features)) return 0
        return collection.features.length
    }, [stopData])

    // Effects
    useEffect(() => {
        if (mapRef.current) return

        mapRef.current = new maplibregl.Map({
            container: mapContainer.current,
            style: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
            center: [-71.0589, 42.3601], // Boston
            zoom: 12
        })

        // Add controls
        mapRef.current.addControl(new maplibregl.NavigationControl({ showCompass: true }))
        mapRef.current.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }))

        mapRef.current.on('load', () => {
            mapReadyRef.current = true
            setMapIsReady(true)

            popupRef.current = new maplibregl.Popup({
                closeButton: false,
                closeOnMove: true,
                offset: 12
            })

            mapRef.current.addSource('bus-routes', {
                type: 'geojson',
                data: EMPTY_GEOJSON
            })

            mapRef.current.addLayer({
                id: 'bus-routes-casing',
                type: 'line',
                source: 'bus-routes',
                paint: {
                    'line-color': '#ffffff',
                    'line-width': 7,
                    'line-opacity': 0.55
                }
            })

            mapRef.current.addLayer({
                id: 'bus-routes-line',
                type: 'line',
                source: 'bus-routes',
                paint: {
                    'line-color': ['get', 'color'],
                    'line-width': [
                        'case',
                        ['boolean', ['feature-state', 'selected'], false],
                        6,
                        ['boolean', ['feature-state', 'hover'], false],
                        5,
                        4
                    ],
                    'line-opacity': [
                        'case',
                        ['boolean', ['feature-state', 'hover'], false],
                        1,
                        0.9
                    ]
                },
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                }
            })

            if (STOP_LAYER && typeof STOP_LAYER === 'object') {
                const { sourceId, layerId } = STOP_LAYER

                if (sourceId && layerId) {
                    const circleOptions = STOP_LAYER.circle ?? {}

                    mapRef.current?.addSource(sourceId, {
                        type: 'geojson',
                        data: EMPTY_GEOJSON
                    })

                    const layerConfig = {
                        id: layerId,
                        type: 'circle',
                        source: sourceId,
                        paint: {
                            'circle-radius': circleOptions.radius ?? 4,
                            'circle-color': circleOptions.color ?? '#1f7bf6',
                            'circle-opacity': circleOptions.opacity ?? 0.7,
                            'circle-stroke-width': circleOptions.strokeWidth ?? 0.9,
                            'circle-stroke-color': circleOptions.strokeColor ?? '#ffffff'
                        }
                    }

                    if (typeof STOP_LAYER.minzoom === 'number') {
                        layerConfig.minzoom = STOP_LAYER.minzoom
                    }

                    if (typeof STOP_LAYER.maxzoom === 'number') {
                        layerConfig.maxzoom = STOP_LAYER.maxzoom
                    }

                    mapRef.current?.addLayer(layerConfig)
                }
            }

            mapRef.current.on('mouseenter', 'bus-routes-line', () => {
                mapRef.current.getCanvas().style.cursor = 'pointer'
            })

            mapRef.current.on('mouseleave', 'bus-routes-line', () => {
                mapRef.current.getCanvas().style.cursor = ''

                if (hoveredRouteRef.current !== null) {
                    mapRef.current.setFeatureState(
                        { source: 'bus-routes', id: hoveredRouteRef.current },
                        { hover: false }
                    )
                    hoveredRouteRef.current = null
                }
            })

            mapRef.current.on('mousemove', 'bus-routes-line', (event) => {
                if (!event.features?.length) return

                const feature = event.features[0]
                const featureId = feature.id

                if (featureId === undefined || featureId === null) return

                if (hoveredRouteRef.current !== featureId) {
                    if (hoveredRouteRef.current !== null) {
                        mapRef.current.setFeatureState(
                            { source: 'bus-routes', id: hoveredRouteRef.current },
                            { hover: false }
                        )
                    }

                    hoveredRouteRef.current = featureId
                    mapRef.current.setFeatureState({ source: 'bus-routes', id: featureId }, { hover: true })
                }
            })

            mapRef.current.on('click', 'bus-routes-line', (event) => {
                if (!event.features?.length) return

                const feature = event.features[0]
                const featureId = feature.id

                if (featureId === undefined || featureId === null) return

                selectedRouteIdRef.current = featureId
                setSelectedRouteId(featureId)

                const { route_id: routeId, name } = feature.properties

                popupRef.current
                    ?.setLngLat(event.lngLat)
                    .setHTML(
                        `<strong>${routeId} ${name}</strong><p class="popup-hint">Shift + click anywhere on the map to append a stop for this route.</p>`
                    )
                    .addTo(mapRef.current)
            })

            mapRef.current.on('click', (event) => {
                if (!mapReadyRef.current) return

                if (event.originalEvent.shiftKey) {
                    if (!selectedRouteIdRef.current) return

                    const { lng, lat } = event.lngLat

                    setRoutesData((current) => ({
                        ...current,
                        features: current.features.map((feature) => {
                            if (feature.id !== selectedRouteIdRef.current) {
                                return feature
                            }

                            const geometry = feature.geometry

                            if (!geometry) {
                                return feature
                            }

                            if (geometry.type === 'LineString') {
                                return {
                                    ...feature,
                                    geometry: {
                                        ...geometry,
                                        coordinates: [...geometry.coordinates, [lng, lat]]
                                    }
                                }
                            }

                            if (geometry.type === 'MultiLineString') {
                                const lineCount = geometry.coordinates.length
                                const targetIndex = Math.max(0, lineCount - 1)
                                const updatedCoordinates = geometry.coordinates.map((segment, index) =>
                                    index === targetIndex ? [...segment, [lng, lat]] : segment
                                )

                                return {
                                    ...feature,
                                    geometry: {
                                        ...geometry,
                                        coordinates: updatedCoordinates
                                    }
                                }
                            }

                            return feature
                        })
                    }))

                    return
                }

                const features = mapRef.current.queryRenderedFeatures(event.point, {
                    layers: ['bus-routes-line']
                })

                if (!features.length) {
                    selectedRouteIdRef.current = null
                    setSelectedRouteId(null)
                    popupRef.current?.remove()
                }
            })
        })

        return () => {
            mapRef.current && mapRef.current.remove()
            mapRef.current = null
            popupRef.current = null
            hoveredRouteRef.current = null
            mapReadyRef.current = false
            selectedRouteIdRef.current = null
            setMapIsReady(false)
        }
    }, [])

    useEffect(() => {
        if (!mapIsReady) return

        let cancelled = false

        const loadData = async () => {
            setIsFetchingData(true)
            setDataError(null)
            setStopDataError(null)

            try {
                const [routesResult, stopsResult] = await Promise.allSettled([
                    fetchMbtaRoutes(),
                    fetchMbtaStops()
                ])

                if (cancelled) return

                if (routesResult.status === 'fulfilled') {
                    setRoutesData(routesResult.value)
                } else {
                    const message = getErrorMessage(
                        routesResult.reason,
                        'Failed to load routes from the MBTA API.'
                    )
                    setRoutesData(EMPTY_GEOJSON)
                    setDataError(message)
                }

                if (stopsResult.status === 'fulfilled') {
                    setStopData(stopsResult.value)
                } else {
                    const message = getErrorMessage(
                        stopsResult.reason,
                        'Failed to load bus stops from the MBTA API.'
                    )
                    setStopData({})
                    setStopDataError(message)
                }
            } finally {
                if (!cancelled) {
                    setIsFetchingData(false)
                }
            }
        }

        loadData()

        return () => {
            cancelled = true
        }
    }, [mapIsReady])

    useEffect(() => {
        if (!mapRef.current || !mapReadyRef.current) return

        const source = mapRef.current.getSource('bus-routes')
        if (source) {
            source.setData(routesData ?? EMPTY_GEOJSON)
        }
    }, [routesData])

    useEffect(() => {
        if (!mapRef.current || !mapReadyRef.current || !stopData) return

        const sourceId = STOP_LAYER?.sourceId
        if (!sourceId) return

        const source = mapRef.current?.getSource(sourceId)
        const data = stopData[sourceId]

        if (source && data) {
            source.setData(data)
        }
    }, [stopData])

    useEffect(() => {
        selectedRouteIdRef.current = selectedRouteId
    }, [selectedRouteId])

    useEffect(() => {
        if (!mapRef.current || !mapReadyRef.current) return
        if (selectedRouteId === null) return

        mapRef.current.setFeatureState(
            { source: 'bus-routes', id: selectedRouteId },
            { selected: true }
        )

        return () => {
            if (!mapRef.current || !mapReadyRef.current) return
            mapRef.current.setFeatureState(
                { source: 'bus-routes', id: selectedRouteId },
                { selected: false }
            )
        }
    }, [selectedRouteId])

    return (
        <div className="map-wrap">
            <div className="info-panel">
                <div className="header">
                    <strong>MBTA Bus Frequency Mapper</strong>
                    <p>
                        Explore existing routes, then select one and <kbd>Shift</kbd> + click anywhere on the route to
                        sketch new stops for rapid frequency testing.
                    </p>
                </div>
                <div className="legend">
                    <h2>MBTA Bus Routes</h2>
                    {dataError ? (
                        <p className="legend-error">{dataError}</p>
                    ) : isFetchingData && !legendItems.length ? (
                        <p className="legend-note">Loading bus routes from the MBTA API…</p>
                    ) : null}
                    <div className="legend-items">
                        {legendItems.map((item) => {
                            const rowStyle = item.isSelected
                                ? {
                                      borderColor: item.color,
                                      boxShadow: `0 0 0 3px ${item.color}33`
                                  }
                                : undefined

                            return (
                                <div key={item.id} className="legend-row" style={rowStyle}>
                                    <span
                                        className="legend-swatch"
                                        style={{ backgroundColor: item.color }}
                                        aria-hidden="true"
                                    />
                                    <div className="legend-route">
                                        <strong>
                                            {item.code} <span>{item.name}</span>
                                        </strong>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                    <p className="legend-note">
                        Routes are sourced from the bundled <code>routes.geojson</code> file. Shift-click the map to
                        append test stops for the selected route.
                    </p>
                    {stopDataError ? (
                        <p className="legend-warning">{stopDataError}</p>
                    ) : isFetchingData && stopCount === 0 ? (
                        <p className="legend-note">Loading MBTA bus stop locations from the live API…</p>
                    ) : stopCount > 0 ? (
                        <p className="legend-note">
                            Loaded {stopCount.toLocaleString()} MBTA bus stops from the live API.
                        </p>
                    ) : (
                        <p className="legend-note">MBTA bus stop locations load directly from the live API.</p>
                    )}
                </div>
            </div>
            <div ref={mapContainer} className="map" />
        </div>
    )
}