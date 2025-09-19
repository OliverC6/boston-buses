import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

// API
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
    minzoom: 11,
    maxzoom: 24,
    circle: {
        radius: [
            'interpolate',
            ['linear'],
            ['zoom'],
            11,
            3.5,
            13,
            5.5,
            15.4,
            7.5,
            17.2,
            9
        ],
        color: '#1f7bf6',
        opacity: 0.85,
        strokeWidth: 1.2,
        strokeColor: '#ffffff'
    }
}

// Constants
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const METERS_PER_MILE = 1609.34
const AVERAGE_BUS_SPEED_MPH = 12
const DWELL_TIME_PER_STOP_SECONDS = 30
const EFFECTIVE_STOP_DIRECTION_FACTOR = 0.5
const AVERAGE_ROUTE_SPAN_PER_BUS_MILES = 1.8
const MAX_ADJUSTED_STOPS = 400

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

function extractRouteId(candidate) {
    if (candidate === null || candidate === undefined) {
        return ''
    }

    if (typeof candidate === 'string') {
        return candidate.trim()
    }

    if (typeof candidate === 'number' || typeof candidate === 'bigint') {
        return String(candidate).trim()
    }

    if (typeof candidate === 'object') {
        const rawId = candidate.id ?? candidate.route_id ?? candidate.routeId

        if (rawId !== undefined && rawId !== null) {
            return String(rawId).trim()
        }
    }

    return ''
}

function getRouteIdFromShape(shape) {
    if (!shape || typeof shape !== 'object') {
        return ''
    }

    const relationship = shape.relationships?.route?.data

    if (Array.isArray(relationship)) {
        for (const item of relationship) {
            const extracted = extractRouteId(item)
            if (extracted) {
                return extracted
            }
        }
    } else {
        const extracted = extractRouteId(relationship)
        if (extracted) {
            return extracted
        }
    }

    const attributesRouteId = shape.attributes?.route_id ?? shape.attributes?.routeId

    if (attributesRouteId !== undefined && attributesRouteId !== null) {
        const extracted = extractRouteId(attributesRouteId)
        if (extracted) {
            return extracted
        }
    }

    return ''
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

function haversineDistanceMeters(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2) {
        return 0
    }

    const [lng1, lat1] = a
    const [lng2, lat2] = b

    const toRadians = (value) => (value * Math.PI) / 180

    const dLat = toRadians(lat2 - lat1)
    const dLng = toRadians(lng2 - lng1)
    const radLat1 = toRadians(lat1)
    const radLat2 = toRadians(lat2)

    const sinLat = Math.sin(dLat / 2)
    const sinLng = Math.sin(dLng / 2)
    const haversine = sinLat * sinLat + Math.cos(radLat1) * Math.cos(radLat2) * sinLng * sinLng
    const arc = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
    const earthRadiusMeters = 6371000

    return earthRadiusMeters * arc
}

function calculateLineDistanceInMeters(coordinates) {
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
        return 0
    }

    let total = 0

    for (let index = 1; index < coordinates.length; index += 1) {
        total += haversineDistanceMeters(coordinates[index - 1], coordinates[index])
    }

    return total
}

function calculateRepresentativeRouteLengthInMeters(geometry) {
    if (!geometry || typeof geometry !== 'object') {
        return 0
    }

    if (geometry.type === 'LineString') {
        return calculateLineDistanceInMeters(geometry.coordinates)
    }

    if (geometry.type === 'MultiLineString') {
        if (!Array.isArray(geometry.coordinates) || !geometry.coordinates.length) {
            return 0
        }

        const segmentLengths = geometry.coordinates
            .map((segment) => calculateLineDistanceInMeters(segment))
            .filter((value) => Number.isFinite(value) && value > 0)

        if (!segmentLengths.length) {
            return 0
        }

        segmentLengths.sort((a, b) => b - a)
        const sampleCount = Math.min(2, segmentLengths.length)
        const total = segmentLengths.slice(0, sampleCount).reduce((sum, value) => sum + value, 0)

        return total / sampleCount
    }

    return 0
}

function calculateEstimatedFrequencyMinutes(routeLengthMeters, stopCount) {
    const length = Number(routeLengthMeters)
    const stopsRaw = Number.isFinite(stopCount) ? stopCount : 0
    const effectiveStops = Math.max(0, stopsRaw * EFFECTIVE_STOP_DIRECTION_FACTOR)

    const speedMetersPerMinute = (AVERAGE_BUS_SPEED_MPH * METERS_PER_MILE) / MINUTES_PER_HOUR
    const travelMinutes = Number.isFinite(length) && length > 0 ? length / speedMetersPerMinute : 0
    const dwellMinutes = effectiveStops * (DWELL_TIME_PER_STOP_SECONDS / SECONDS_PER_MINUTE)
    const cycleMinutes = travelMinutes + dwellMinutes

    if (!Number.isFinite(cycleMinutes) || cycleMinutes <= 0) {
        return dwellMinutes > 0 ? dwellMinutes : null
    }

    const routeLengthMiles = length / METERS_PER_MILE
    const estimatedBusesInService = Math.max(
        1,
        Math.round(routeLengthMiles / AVERAGE_ROUTE_SPAN_PER_BUS_MILES) || 1
    )

    const frequencyMinutes = cycleMinutes / estimatedBusesInService

    if (!Number.isFinite(frequencyMinutes) || frequencyMinutes <= 0) {
        return dwellMinutes > 0 ? dwellMinutes : null
    }

    return frequencyMinutes
}

function interpolateCoordinate(start, end, t) {
    if (!Array.isArray(start) || !Array.isArray(end) || start.length !== 2 || end.length !== 2) {
        return null
    }

    const clampedT = Math.min(Math.max(t, 0), 1)

    return [
        start[0] + (end[0] - start[0]) * clampedT,
        start[1] + (end[1] - start[1]) * clampedT
    ]
}

function sampleCoordinatesAlongGeometry(geometry, count) {
    const targetCount = Math.max(0, Math.floor(count))

    if (!geometry || typeof geometry !== 'object' || targetCount <= 0) {
        return []
    }

    const lineStrings = []

    if (geometry.type === 'LineString') {
        lineStrings.push(geometry.coordinates)
    } else if (geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
        for (const line of geometry.coordinates) {
            lineStrings.push(line)
        }
    }

    const segments = []

    for (const line of lineStrings) {
        if (!Array.isArray(line) || line.length < 2) continue

        for (let index = 1; index < line.length; index += 1) {
            const start = line[index - 1]
            const end = line[index]
            const length = haversineDistanceMeters(start, end)

            if (length > 0) {
                segments.push({ start, end, length })
            }
        }
    }

    if (!segments.length) {
        const fallback = lineStrings.find((line) => Array.isArray(line) && line.length)?.[0]
        if (!fallback) return []
        return Array.from({ length: targetCount }, () => [...fallback])
    }

    const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0)

    if (totalLength <= 0) {
        const first = segments[0].start
        return Array.from({ length: targetCount }, () => [...first])
    }

    if (targetCount === 1) {
        return [[...segments[0].start]]
    }

    const spacing = totalLength / (targetCount - 1)
    const coordinates = []
    let accumulated = 0
    let segmentIndex = 0

    for (let index = 0; index < targetCount; index += 1) {
        const targetDistance = spacing * index

        while (
            segmentIndex < segments.length - 1 &&
            accumulated + segments[segmentIndex].length < targetDistance
        ) {
            accumulated += segments[segmentIndex].length
            segmentIndex += 1
        }

        const segment = segments[segmentIndex]

        if (!segment) {
            coordinates.push([...segments[segments.length - 1].end])
            continue
        }

        const distanceIntoSegment = targetDistance - accumulated
        const ratio = segment.length === 0 ? 0 : distanceIntoSegment / segment.length
        const interpolated = interpolateCoordinate(segment.start, segment.end, ratio)

        coordinates.push(interpolated ? [...interpolated] : [...segment.start])
    }

    return coordinates
}

function selectEvenlySpacedStops(features, targetCount) {
    if (!Array.isArray(features) || !features.length || targetCount <= 0) {
        return []
    }

    if (targetCount >= features.length) {
        return features.slice()
    }

    if (targetCount === 1) {
        return [features[0]]
    }

    const result = []
    const interval = (features.length - 1) / (targetCount - 1)

    for (let index = 0; index < targetCount; index += 1) {
        const position = index * interval
        const sourceIndex = Math.min(Math.round(position), features.length - 1)
        const feature = features[sourceIndex]

        if (feature) {
            result.push(feature)
        }
    }

    return result
}

function createGeneratedStopFeature(coordinate, index, name) {
    if (!Array.isArray(coordinate) || coordinate.length !== 2) {
        return null
    }

    return {
        type: 'Feature',
        id: `generated-stop-${index}`,
        geometry: {
            type: 'Point',
            coordinates: [...coordinate]
        },
        properties: {
            name: name || `Proposed Stop ${index + 1}`,
            description: 'Synthetic stop for frequency scenario testing.',
            isSynthetic: true
        }
    }
}

function buildAdjustedStopCollection(baseCollection, geometry, targetCount) {
    const count = Math.max(0, Math.floor(targetCount))

    if (count <= 0) {
        return { type: 'FeatureCollection', features: [] }
    }

    const baseFeatures = Array.isArray(baseCollection?.features)
        ? baseCollection.features.filter((feature) => feature?.geometry?.type === 'Point')
        : []
    const baseCount = baseFeatures.length

    if (baseCount === 0) {
        const generatedCoordinates = sampleCoordinatesAlongGeometry(geometry, count)
        const generatedFeatures = generatedCoordinates
            .map((coordinate, index) => createGeneratedStopFeature(coordinate, index, `Proposed Stop ${index + 1}`))
            .filter(Boolean)

        return { type: 'FeatureCollection', features: generatedFeatures.slice(0, count) }
    }

    if (count <= baseCount) {
        const reduced = selectEvenlySpacedStops(baseFeatures, count)
        return { type: 'FeatureCollection', features: reduced }
    }

    const additionalNeeded = count - baseCount

    if (baseCount < 2) {
        const coordinates = sampleCoordinatesAlongGeometry(geometry, additionalNeeded)
        const generated = coordinates
            .map((coordinate, index) =>
                createGeneratedStopFeature(coordinate, baseCount + index, `Proposed Stop ${baseCount + index + 1}`)
            )
            .filter(Boolean)

        const combined = [...baseFeatures, ...generated]
        return { type: 'FeatureCollection', features: combined.slice(0, count) }
    }

    const segments = []

    for (let index = 1; index < baseCount; index += 1) {
        const previous = baseFeatures[index - 1]?.geometry?.coordinates
        const current = baseFeatures[index]?.geometry?.coordinates

        if (!previous || !current) continue

        const length = haversineDistanceMeters(previous, current)
        segments.push({ start: previous, end: current, length })
    }

    const allocations = new Array(segments.length).fill(0)

    if (segments.length) {
        const totalLength = segments.reduce((sum, segment) => sum + (segment.length || 0), 0)

        if (totalLength > 0) {
            const remainders = []
            let allocated = 0

            for (let index = 0; index < segments.length; index += 1) {
                const segment = segments[index]
                const exactShare = (segment.length / totalLength) * additionalNeeded
                const floorShare = Math.floor(exactShare)
                allocations[index] = floorShare
                allocated += floorShare
                remainders.push({ index, remainder: exactShare - floorShare })
            }

            let remaining = additionalNeeded - allocated

            const sortedRemainders = remainders.sort((a, b) => b.remainder - a.remainder)

            for (const item of sortedRemainders) {
                if (remaining <= 0) {
                    break
                }

                allocations[item.index] += 1
                remaining -= 1
            }

            let cycleIndex = 0

            while (remaining > 0) {
                const target = allocations.length ? cycleIndex % allocations.length : 0
                allocations[target] += 1
                remaining -= 1
                cycleIndex += 1
            }
        } else {
            let assigned = 0
            while (assigned < additionalNeeded) {
                const target = assigned % allocations.length
                allocations[target] += 1
                assigned += 1
            }
        }
    }

    const generatedStops = []
    const orderedFeatures = []

    if (baseCount > 0) {
        orderedFeatures.push(baseFeatures[0])

        for (let index = 1; index < baseCount; index += 1) {
            const allocation = allocations[index - 1] ?? 0
            const segment = segments[index - 1]

            if (allocation > 0 && segment) {
                for (let step = 1; step <= allocation; step += 1) {
                    const ratio = step / (allocation + 1)
                    const coordinate = interpolateCoordinate(segment.start, segment.end, ratio)
                    const feature = createGeneratedStopFeature(
                        coordinate,
                        baseCount + generatedStops.length,
                        `Proposed Stop ${baseCount + generatedStops.length + 1}`
                    )

                    if (feature) {
                        generatedStops.push(feature)
                        orderedFeatures.push(feature)
                    }
                }
            }

            orderedFeatures.push(baseFeatures[index])
        }
    }

    if (generatedStops.length < additionalNeeded) {
        const fallbackCoordinates = sampleCoordinatesAlongGeometry(geometry, additionalNeeded - generatedStops.length)

        for (const coordinate of fallbackCoordinates) {
            const feature = createGeneratedStopFeature(
                coordinate,
                baseCount + generatedStops.length,
                `Proposed Stop ${baseCount + generatedStops.length + 1}`
            )

            if (!feature) continue

            generatedStops.push(feature)
            orderedFeatures.push(feature)

            if (generatedStops.length >= additionalNeeded) {
                break
            }
        }
    }

    const combined = orderedFeatures.length ? orderedFeatures : [...baseFeatures, ...generatedStops]

    return { type: 'FeatureCollection', features: combined.slice(0, count) }
}

function escapeHtml(value) {
    if (typeof value !== 'string') {
        return ''
    }

    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}

function formatFrequencyMinutes(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) {
        return '—'
    }

    if (minutes < 1) {
        return `${minutes.toFixed(2)} min`
    }

    if (minutes < 10) {
        return `${minutes.toFixed(1)} min`
    }

    return `${minutes.toFixed(0)} min`
}

// Defaults
const DEFAULT_STOP_SCENARIO = {
    baseCount: 0,
    adjustedCount: 0,
    factor: 1,
    baseFrequencyMinutes: null,
    adjustedFrequencyMinutes: null
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

async function fetchMbtaRouteShapes(routeIds, shapesByRoute, routeMetadata) {
    if (!Array.isArray(routeIds) || !routeIds.length) {
        return
    }

    const validRouteIds = routeIds
        .map((routeId) => (typeof routeId === 'string' ? routeId.trim() : ''))
        .filter(Boolean)

    if (!validRouteIds.length) {
        return
    }

    for (const routeId of validRouteIds) {
        if (!routeId) {
            return
        }

        const url = new URL('https://api-v3.mbta.com/shapes')
        url.searchParams.set('filter[route]', routeId)
        url.searchParams.set('include', 'route')

        const pageLimit = 500
        let pageOffset = 0

        while (true) {
            url.searchParams.set('page[limit]', String(pageLimit))
            url.searchParams.set('page[offset]', String(pageOffset))

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

                const resolvedRouteId = getRouteIdFromShape(item) || routeId
                if (!resolvedRouteId) continue

                const attributes = item.attributes ?? {}
                const polyline = typeof attributes.polyline === 'string' ? attributes.polyline : ''
                if (!polyline) continue

                const coordinates = decodePolyline(polyline)
                if (coordinates.length < 2) continue

                const existing = shapesByRoute.get(resolvedRouteId)

                if (existing) {
                    existing.push(coordinates)
                } else {
                    shapesByRoute.set(resolvedRouteId, [coordinates])
                }
            }

            if (Array.isArray(payload.included)) {
                for (const includedItem of payload.included) {
                    if (!includedItem || includedItem.type !== 'route') continue

                    const includedRouteId = includedItem.id
                    if (!includedRouteId || routeMetadata.has(includedRouteId)) continue

                    const attributes = includedItem.attributes ?? {}
                    const shortName =
                        typeof attributes.short_name === 'string' ? attributes.short_name.trim() : ''
                    const longName =
                        typeof attributes.long_name === 'string' ? attributes.long_name.trim() : ''
                    const description =
                        typeof attributes.description === 'string' ? attributes.description.trim() : ''

                    routeMetadata.set(includedRouteId, {
                        id: includedRouteId,
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
        await fetchMbtaRouteShapes(batch, shapesByRoute, routeMetadata)
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

async function fetchMbtaStopsForRoute(routeId) {
    const normalizedRouteId = extractRouteId(routeId)

    if (!normalizedRouteId) {
        throw new Error('A valid route ID is required to load bus stops.')
    }

    const stops = []
    const url = new URL('https://api-v3.mbta.com/stops')
    const pageLimit = 200
    let pageOffset = 0

    while (true) {
        url.searchParams.set('page[limit]', String(pageLimit))
        url.searchParams.set('page[offset]', String(pageOffset))
        url.searchParams.set('filter[route]', normalizedRouteId)
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

    return { type: 'FeatureCollection', features: stops }
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
    const selectedRouteFeatureRef = useRef(null)
    const selectedRouteLengthRef = useRef(0)
    const stopCacheRef = useRef(new Map())
    const baseStopCollectionRef = useRef(EMPTY_GEOJSON)
    const stopScenarioRef = useRef({ ...DEFAULT_STOP_SCENARIO })

    // States
    const [routesData, setRoutesData] = useState(EMPTY_GEOJSON)
    const [selectedRouteId, setSelectedRouteId] = useState(null)
    const [mapIsReady, setMapIsReady] = useState(false)
    const [isFetchingData, setIsFetchingData] = useState(false)
    const [isFetchingStops, setIsFetchingStops] = useState(false)
    const [dataError, setDataError] = useState(null)
    const [stopDataError, setStopDataError] = useState(null)
    //const [visibleStopCount, setVisibleStopCount] = useState(0)
    const [stopDisplayCollection, setStopDisplayCollection] = useState(EMPTY_GEOJSON)
    const [stopScenarioState, setStopScenarioState] = useState({ ...DEFAULT_STOP_SCENARIO })

    // Callbacks
    const updateStopScenario = useCallback((scenario) => {
        const merged = { ...DEFAULT_STOP_SCENARIO, ...scenario }
        stopScenarioRef.current = merged
        setStopScenarioState(merged)
    }, [])

    const clearRouteSelection = useCallback(() => {
        selectedRouteIdRef.current = null
        selectedRouteFeatureRef.current = null
        selectedRouteLengthRef.current = 0
        baseStopCollectionRef.current = EMPTY_GEOJSON
        popupRef.current?.remove()
        setSelectedRouteId(null)
        setStopDisplayCollection(EMPTY_GEOJSON)
        setIsFetchingStops(false)
        setStopDataError(null)
        updateStopScenario(DEFAULT_STOP_SCENARIO)
    }, [updateStopScenario])

    const handlePopupClose = useCallback(() => {
        clearRouteSelection()
    }, [clearRouteSelection])

    const adjustStopsByPercentage = useCallback(
        (change) => {
            const routeFeature = selectedRouteFeatureRef.current
            const geometry = routeFeature?.geometry

            if (!geometry) return

            const baseCollection = baseStopCollectionRef.current
            const baseFeatures = Array.isArray(baseCollection?.features)
                ? baseCollection.features.filter((feature) => feature?.geometry?.type === 'Point')
                : []
            const baseCount = baseFeatures.length

            const currentScenario = stopScenarioRef.current
            const currentAdjustedCount = currentScenario.adjustedCount || baseCount || 1

            const maxCount = MAX_ADJUSTED_STOPS
            let targetCount
            let nextFactor

            if (baseCount > 0) {
                const currentFactor = currentScenario.factor || currentAdjustedCount / baseCount || 1
                const proposedFactor = currentFactor * (1 + change)
                const minFactor = 1 / baseCount
                const maxFactor = maxCount / baseCount
                const boundedFactor = Math.min(Math.max(proposedFactor, minFactor), maxFactor)
                targetCount = Math.max(1, Math.round(baseCount * boundedFactor))

                if (targetCount === currentAdjustedCount) {
                    if (change > 0 && targetCount < maxCount) {
                        targetCount += 1
                    } else if (change < 0 && targetCount > 1) {
                        targetCount -= 1
                    }
                }

                nextFactor = targetCount / baseCount
            } else {
                const proposedCount = Math.round(currentAdjustedCount * (1 + change))
                targetCount = Math.max(1, Math.min(maxCount, proposedCount || 1))

                if (targetCount === currentAdjustedCount) {
                    if (change > 0 && targetCount < maxCount) {
                        targetCount += 1
                    } else if (change < 0 && targetCount > 1) {
                        targetCount -= 1
                    }
                }

                nextFactor = currentScenario.factor || 1
            }

            targetCount = Math.max(1, Math.min(maxCount, targetCount))

            if (!Number.isFinite(targetCount) || targetCount <= 0) {
                return
            }

            const routeLength =
                selectedRouteLengthRef.current || calculateRepresentativeRouteLengthInMeters(geometry)

            if (Number.isFinite(routeLength)) {
                selectedRouteLengthRef.current = routeLength
            }

            const adjustedCollection = buildAdjustedStopCollection(baseCollection, geometry, targetCount)
            setStopDisplayCollection(adjustedCollection)

            const adjustedFrequency = calculateEstimatedFrequencyMinutes(routeLength, targetCount)
            const baseFrequency =
                currentScenario.baseFrequencyMinutes ??
                calculateEstimatedFrequencyMinutes(routeLength, baseCount)

            updateStopScenario({
                baseCount,
                adjustedCount: targetCount,
                factor: nextFactor,
                baseFrequencyMinutes: baseFrequency,
                adjustedFrequencyMinutes: adjustedFrequency
            })
        },
        [updateStopScenario]
    )

    const handleIncreaseStops = useCallback(
        (event) => {
            if (event && typeof event.preventDefault === 'function') {
                event.preventDefault()
            }
            adjustStopsByPercentage(0.25)
        },
        [adjustStopsByPercentage]
    )

    const handleDecreaseStops = useCallback(
        (event) => {
            if (event && typeof event.preventDefault === 'function') {
                event.preventDefault()
            }
            adjustStopsByPercentage(-0.25)
        },
        [adjustStopsByPercentage]
    )

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

    const selectedLegendItem = useMemo(
        () => legendItems.find((item) => item.id === selectedRouteId) ?? null,
        [legendItems, selectedRouteId]
    )

    const selectedRouteLabel = useMemo(() => {
        if (!selectedRouteId) return ''

        if (selectedLegendItem) {
            const trimmedName = selectedLegendItem.name?.trim()
            if (selectedLegendItem.code && trimmedName) {
                return `${selectedLegendItem.code} ${trimmedName}`
            }

            if (selectedLegendItem.code) {
                return selectedLegendItem.code
            }

            if (trimmedName) {
                return trimmedName
            }
        }

        return selectedRouteId
    }, [selectedLegendItem, selectedRouteId])

    const stopCount = stopScenarioState.adjustedCount ?? 0

    // Popup
    const updatePopupContent = useCallback(() => {
        if (!popupRef.current) return

        const isPopupOpen = typeof popupRef.current.isOpen === 'function' ? popupRef.current.isOpen() : true

        if (!isPopupOpen) {
            return
        }

        const feature = selectedRouteFeatureRef.current
        if (!feature) return

        const routeId = feature.properties?.route_id ?? ''
        const routeName = feature.properties?.name ?? ''
        const headerLabel =
            selectedRouteLabel || [routeId, routeName].filter(Boolean).join(' ').trim() || 'MBTA Bus Route'
        
        const legendCode = typeof selectedLegendItem?.code === 'string' ? selectedLegendItem.code.trim() : ''
        const legendName = typeof selectedLegendItem?.name === 'string' ? selectedLegendItem.name.trim() : ''
        const routeColorCandidate =
            typeof selectedLegendItem?.color === 'string'
                ? selectedLegendItem.color.trim()
                : typeof feature.properties?.color === 'string'
                  ? feature.properties.color.trim()
                  : ''

        const routeTitle = legendName || routeName || headerLabel || 'MBTA Bus Route'
        const normalizedRouteTitle = routeTitle.trim() || 'MBTA Bus Route'

        let routeCode = legendCode || routeId
        if (typeof routeCode === 'string') {
            const trimmedCode = routeCode.trim()
            routeCode =
                trimmedCode &&
                trimmedCode.toLowerCase() !== normalizedRouteTitle.toLowerCase()
                    ? trimmedCode
                    : ''
        } else {
            routeCode = ''
        }

        const headerHtml = `
            <div class="popup-header">
                <div class="popup-header-main">
                    <span class="popup-color-indicator" aria-hidden="true"></span>
                    <div class="popup-title">
                        ${routeCode ? `<span class="popup-route-code">${escapeHtml(routeCode)}</span>` : ''}
                        <strong class="popup-route-name">${escapeHtml(normalizedRouteTitle)}</strong>
                    </div>
                </div>
                <button
                    type="button"
                    class="popup-close-button"
                    data-action="close-popup"
                    aria-label="Close popup"
                >
                    <span aria-hidden="true">&times;</span>
                </button>
            </div>
        `

        const scenario = stopScenarioRef.current
        const frequencyText = formatFrequencyMinutes(scenario.adjustedFrequencyMinutes)
        const baseFrequencyText = formatFrequencyMinutes(scenario.baseFrequencyMinutes)

        const adjustedCountNumber = Number.isFinite(scenario.adjustedCount) ? scenario.adjustedCount : 0
        const baseCountNumber = Number.isFinite(scenario.baseCount) ? scenario.baseCount : 0
        const adjustedCountText = adjustedCountNumber.toLocaleString()
        const baseCountText = baseCountNumber.toLocaleString()

        const scenarioInfoParts = []

        if (Number.isFinite(scenario.baseFrequencyMinutes)) {
            scenarioInfoParts.push(`Baseline ${baseFrequencyText}`)
        }

        if (baseCountNumber > 0) {
            if (adjustedCountNumber !== baseCountNumber) {
                scenarioInfoParts.push(`Stops ${adjustedCountText} (base ${baseCountText})`)
            } else {
                scenarioInfoParts.push(`Stops ${adjustedCountText}`)
            }
        } else {
            scenarioInfoParts.push(`Stops ${adjustedCountText}`)
        }

        const disableButtons = Boolean(isFetchingStops || !feature.geometry || stopDataError)
        const buttonDisabledAttr = disableButtons ? ' disabled aria-disabled="true"' : ''

        const infoHtml = scenarioInfoParts.length
            ? `<p class="popup-meta">${scenarioInfoParts
                  .map((part) => escapeHtml(part))
                  .join(' &bull; ')}</p>`
            : ''

        const loadingHtml = isFetchingStops ? '<p class="popup-note">Loading stops…</p>' : ''
        const noStopsHtml =
            !isFetchingStops && !stopDataError && baseCountNumber === 0 && adjustedCountNumber === 0
                ? '<p class="popup-note">No stops are currently loaded for this route.</p>'
                : ''
        const errorHtml = stopDataError
            ? `<p class="popup-error">${escapeHtml(stopDataError)}</p>`
            : ''

        const containerColor = routeColorCandidate || '#0f3d91'
        const html = `
            <div class="popup-content" style="--popup-route-color: ${escapeHtml(containerColor)};">
                ${headerHtml}
                <p class="popup-frequency">
                    Estimated frequency
                    <span class="popup-frequency-value">${escapeHtml(frequencyText)}</span>
                </p>
                ${infoHtml}
                <div class="popup-actions">
                    <button type="button" data-action="decrease"${buttonDisabledAttr}>-25% stops</button>
                    <button type="button" data-action="increase"${buttonDisabledAttr}>+25% stops</button>
                </div>
                ${errorHtml}
                ${loadingHtml || noStopsHtml}
            </div>
        `

        popupRef.current.setHTML(html)

        const popupElement = popupRef.current.getElement()
        if (!popupElement) {
            return
        }

        const closeButton = popupElement.querySelector('[data-action="close-popup"]')
        if (closeButton) {
            closeButton.addEventListener('click', handlePopupClose, { once: false })
        }

        if (disableButtons) {
            return
        }

        const increaseButton = popupElement.querySelector('[data-action="increase"]')
        const decreaseButton = popupElement.querySelector('[data-action="decrease"]')

        if (increaseButton) {
            increaseButton.addEventListener('click', handleIncreaseStops, { once: false })
        }

        if (decreaseButton) {
            decreaseButton.addEventListener('click', handleDecreaseStops, { once: false })
        }
    }, [handleDecreaseStops,
        handleIncreaseStops,
        handlePopupClose,
        isFetchingStops,
        selectedLegendItem,
        selectedRouteLabel,
        stopDataError
    ])

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
                closeOnClick: false,
                closeOnMove: false,
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
                selectedRouteFeatureRef.current = feature

                                const geometryLength = calculateRepresentativeRouteLengthInMeters(feature.geometry)
                if (Number.isFinite(geometryLength)) {
                    selectedRouteLengthRef.current = geometryLength
                } else {
                    selectedRouteLengthRef.current = 0
                }

                setSelectedRouteId(featureId)

                const cachedCollection = stopCacheRef.current.get(featureId)

                if (cachedCollection) {
                    baseStopCollectionRef.current = cachedCollection
                    setStopDisplayCollection(cachedCollection)

                    const baseCount = Array.isArray(cachedCollection?.features)
                        ? cachedCollection.features.length
                        : 0
                    const baseFrequency = calculateEstimatedFrequencyMinutes(
                        selectedRouteLengthRef.current,
                        baseCount
                    )

                    updateStopScenario({
                        baseCount,
                        adjustedCount: baseCount,
                        factor: baseCount > 0 ? 1 : 1,
                        baseFrequencyMinutes: baseFrequency,
                        adjustedFrequencyMinutes: baseFrequency
                    })
                } else {
                    baseStopCollectionRef.current = EMPTY_GEOJSON
                    setStopDisplayCollection(EMPTY_GEOJSON)
                    updateStopScenario(DEFAULT_STOP_SCENARIO)
                }

                popupRef.current
                    ?.setLngLat(event.lngLat)
                    .setHTML('<p class="popup-note">Loading route details…</p>')
                    .addTo(mapRef.current)

                updatePopupContent()
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
                    selectedRouteFeatureRef.current = null
                    selectedRouteLengthRef.current = 0
                    setSelectedRouteId(null)
                    baseStopCollectionRef.current = EMPTY_GEOJSON
                    setStopDisplayCollection(EMPTY_GEOJSON)
                    updateStopScenario(DEFAULT_STOP_SCENARIO)
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
            selectedRouteFeatureRef.current = null
            selectedRouteLengthRef.current = 0
            baseStopCollectionRef.current = EMPTY_GEOJSON
            stopScenarioRef.current = { ...DEFAULT_STOP_SCENARIO }
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
                const routesResult = await fetchMbtaRoutes()
                if (cancelled) return
               setRoutesData(routesResult)
            } catch (error) {
                if (cancelled) return
                const message = getErrorMessage(
                    error,
                    'Failed to load routes from the MBTA API.'
                )
                setRoutesData(EMPTY_GEOJSON)
                setDataError(message)
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
        selectedRouteIdRef.current = selectedRouteId
    }, [selectedRouteId])

    useEffect(() => {
        if (!mapRef.current || !mapReadyRef.current) return

        const sourceId = STOP_LAYER?.sourceId
        if (!sourceId) return

        let cancelled = false

        const resetScenario = () => {
            if (cancelled) return
            baseStopCollectionRef.current = EMPTY_GEOJSON
            setStopDisplayCollection(EMPTY_GEOJSON)
            updateStopScenario(DEFAULT_STOP_SCENARIO)
        }

        if (!selectedRouteId) {
            setIsFetchingStops(false)
            setStopDataError(null)
            resetScenario()
            return
        }

        setStopDataError(null)

        const computedRouteLength =
            selectedRouteLengthRef.current ||
            calculateRepresentativeRouteLengthInMeters(selectedRouteFeatureRef.current?.geometry)

        if (Number.isFinite(computedRouteLength)) {
            selectedRouteLengthRef.current = computedRouteLength
        }

        const applyCollection = (collection) => {
            baseStopCollectionRef.current = collection
            setStopDisplayCollection(collection)

            const baseCount = Array.isArray(collection?.features) ? collection.features.length : 0
            const baseFrequency = calculateEstimatedFrequencyMinutes(
                selectedRouteLengthRef.current,
                baseCount
            )

            updateStopScenario({
                baseCount,
                adjustedCount: baseCount,
                factor: baseCount > 0 ? 1 : 1,
                baseFrequencyMinutes: baseFrequency,
                adjustedFrequencyMinutes: baseFrequency
            })
        }

        const cached = stopCacheRef.current.get(selectedRouteId)

        if (cached) {
            applyCollection(cached)
            setIsFetchingStops(false)
            return
        }

        const requestedRouteId = selectedRouteId
        setIsFetchingStops(true)
        resetScenario()

        fetchMbtaStopsForRoute(requestedRouteId)
            .then((collection) => {
                if (cancelled) return
                stopCacheRef.current.set(requestedRouteId, collection)

                if (selectedRouteIdRef.current !== requestedRouteId) {
                    return
                }

                applyCollection(collection)
            })
            .catch((error) => {
                if (cancelled) return

                if (selectedRouteIdRef.current !== requestedRouteId) {
                    return
                }

                const message = getErrorMessage(
                    error,
                    `Failed to load bus stops for route ${requestedRouteId} from the MBTA API.`
                )
                setStopDataError(message)
                resetScenario()
            })
            .finally(() => {
                if (cancelled) return

                if (selectedRouteIdRef.current === requestedRouteId) {
                    setIsFetchingStops(false)
                }
            })

        return () => {
            cancelled = true
        }

    }, [selectedRouteId, mapIsReady, updateStopScenario])

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

    useEffect(() => {
        if (!mapRef.current || !mapReadyRef.current) return

        const sourceId = STOP_LAYER?.sourceId
        if (!sourceId) return

        const source = mapRef.current.getSource(sourceId)
        if (!source) return

        source.setData(stopDisplayCollection ?? EMPTY_GEOJSON)
    }, [stopDisplayCollection])

    useEffect(() => {
        updatePopupContent()
    }, [stopScenarioState, updatePopupContent])

    return (
        <div className="map-wrap">
            <div className="info-panel">
                <div className="header">
                    <strong>MBTA Bus Frequency Mapper</strong>
                    <p>
                        Select a route to change its bus stops on the map.
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
                    {stopDataError ? (
                        <p className="legend-warning">{stopDataError}</p>
                    ) : selectedRouteId ? (
                        isFetchingStops ? (
                            <p className="legend-note">
                                Loading bus stops for route {selectedRouteLabel || selectedRouteId}…
                            </p>
                        ) : stopCount > 0 ? (
                            <p className="legend-note">
                                Showing {stopCount.toLocaleString()} bus stops for route{' '}
                                {selectedRouteLabel || selectedRouteId}.
                            </p>
                        ) : (
                            <p className="legend-note">
                                No bus stops were returned for route {selectedRouteLabel || selectedRouteId}.
                            </p>
                        )
                    ) : (
                        <p className="legend-note"></p>
                    )}
                </div>
            </div>
            <div ref={mapContainer} className="map" />
        </div>
    )
}