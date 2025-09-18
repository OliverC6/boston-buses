import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

// Data
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
const ROUTES_LAYER_ID = 3
const EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] }

// Layer Configs
const STOP_LAYER_CONFIGS = [
    {
        arcgisLayerId: 2,
        sourceId: 'bus-stops-overview-source',
        layerId: 'bus-stops-overview-layer',
        minzoom: 13.5,
        maxzoom: 15.4,
        circleRadius: 3.2,
        circleOpacity: 0.55
    },
    {
        arcgisLayerId: 1,
        sourceId: 'bus-stops-community-source',
        layerId: 'bus-stops-community-layer',
        minzoom: 15.4,
        maxzoom: 17.2,
        circleRadius: 3.9,
        circleOpacity: 0.65
    },
    {
        arcgisLayerId: 0,
        sourceId: 'bus-stops-detail-source',
        layerId: 'bus-stops-detail-layer',
        minzoom: 17.2,
        circleRadius: 4.6,
        circleOpacity: 0.75
    }
]

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

// Fetch Functions
async function fetchLayerFeatures(layerId) {
    const response = await fetch(`${API_BASE_URL}/api/massgis/layers/${layerId}`)

    if (!response.ok) {
        const message = await response.text()
        throw new Error(`MassGIS layer ${layerId} request failed: ${response.status} ${message}`)
    }

    return response.json()
}

async function fetchMassGisRoutes() {
    const featureCollection = await fetchLayerFeatures(ROUTES_LAYER_ID)

    return {
        type: 'FeatureCollection',
        features: featureCollection.features
            .map((feature) => {
                if (!feature?.geometry) return null

                const properties = feature.properties ?? {}
                const routeId = (properties.MBTA_ROUTE || '').trim()
                const variant = (properties.MBTA_ROUTEVAR || '').trim()
                const headsign = (properties.TRIP_HEADSIGN || '').trim()
                const descriptor = (properties.ROUTE_DESC || '').trim()
                const color = getRouteColor(routeId || variant)

                const displayName = descriptor || headsign || (routeId ? `Route ${routeId}` : 'MBTA Bus Route')
                const descriptionParts = [descriptor, headsign]
                    .map((part) => part && part.trim())
                    .filter(Boolean)
                const description = descriptionParts.join(' • ') || 'Variant from the MassGIS MBTA Bus Routes layer.'

                return {
                    ...feature,
                    id: properties.SHAPE_ID || properties.OBJECTID || `${routeId}-${variant}` || feature.id,
                    properties: {
                        ...properties,
                        route_id: routeId || variant || 'N/A',
                        name: displayName,
                        description,
                        color
                    }
                }
            })
            .filter(Boolean)
    }
}

async function fetchMassGisStops() {
    const entries = await Promise.all(
        STOP_LAYER_CONFIGS.map(async (config) => {
            const data = await fetchLayerFeatures(config.arcgisLayerId)
            return [config.sourceId, data]
        })
    )

    return Object.fromEntries(entries)
}

// Component
export default function App() {
    // Ref
    const mapContainer = useRef(null)
    const mapRef = useRef(null)
    const popupRef = useRef(null)
    const hoveredRouteRef = useRef(null)
    const mapReadyRef = useRef(false)
    const selectedRouteIdRef = useRef(null)

    // State
    const [routesData, setRoutesData] = useState(EMPTY_GEOJSON)
    const [stopData, setStopData] = useState(null)
    const [selectedRouteId, setSelectedRouteId] = useState(null)
    const [mapIsReady, setMapIsReady] = useState(false)
    const [isFetchingData, setIsFetchingData] = useState(false)
    const [dataError, setDataError] = useState(null)

    // Memo
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
                description: feature.properties.description
            })),
        [routesData, selectedRouteId]
    )

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

            STOP_LAYER_CONFIGS.forEach((config) => {
                mapRef.current?.addSource(config.sourceId, {
                    type: 'geojson',
                    data: EMPTY_GEOJSON
                })

                mapRef.current?.addLayer({
                    id: config.layerId,
                    type: 'circle',
                    source: config.sourceId,
                    minzoom: config.minzoom,
                    maxzoom: config.maxzoom,
                    paint: {
                        'circle-radius': config.circleRadius,
                        'circle-color': '#1f7bf6',
                        'circle-opacity': config.circleOpacity,
                        'circle-stroke-width': 0.6,
                        'circle-stroke-color': '#ffffff'
                    }
                })
            })

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

                const { route_id: routeId, name, description } = feature.properties

                popupRef.current
                    ?.setLngLat(event.lngLat)
                    .setHTML(
                        `<strong>${routeId} ${name}</strong><p>${description}</p><p class="popup-hint">Shift + click anywhere on the map to append a waypoint for this route.</p>`
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

            try {
                const [routes, stops] = await Promise.all([fetchMassGisRoutes(), fetchMassGisStops()])

                if (cancelled) return

                setRoutesData(routes)
                setStopData(stops)
            } catch (error) {
                if (!cancelled) {
                    const message = error instanceof Error ? error.message : 'Failed to load MassGIS data'
                    setDataError(message)
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

        STOP_LAYER_CONFIGS.forEach((config) => {
            const source = mapRef.current?.getSource(config.sourceId)
            const data = stopData[config.sourceId]

            if (source && data) {
                source.setData(data)
            }
        })
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
                    <strong>MBTA Bus Scenario Mapper</strong>
                    <p>
                        Explore existing routes, then select one and <kbd>Shift</kbd> + click anywhere on the map to
                        sketch new waypoints for rapid scenario testing.
                    </p>
                </div>
                <div className="legend">
                    <h2>MBTA Bus Routes</h2>
                    {dataError ? (
                        <p className="legend-error">{dataError}</p>
                    ) : isFetchingData && !legendItems.length ? (
                        <p className="legend-note">Loading MassGIS bus routes…</p>
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
                                        <span className="legend-description">{item.description}</span>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                    <p className="legend-note">
                        Routes and stops from the MassGIS MBTA Bus Stops &amp; Routes dataset. Shift-click the
                        map to append test waypoints for the selected variant.
                    </p>
                </div>
            </div>
            <div ref={mapContainer} className="map" />
        </div>
    )
}