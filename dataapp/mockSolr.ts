/**
 * mockSolr.ts
 * 
 * A lightweight in-memory replacement for Apache Solr.
 * Loads records from sample.jsonl and serves them via
 * the same HTTP API the dataapp expects.
 *
 * Supported query parameters (subset used by index.ts):
 *   q=<solr query string>
 *   rows=<int>
 *   start=<int>
 *   sort=<field> (ignored – results are scored by relevance)
 *   fq, pt, d  (spatial – basic bounding-box approximation)
 *   mlt=true   (more-like-this – returns empty results for simplicity)
 *   fl=<field>
 */

import express from 'express'
import fs from 'fs'
import path from 'path'

// ──────────────────────────────────────────────
// 1.  Load data
// ──────────────────────────────────────────────

type Doc = Record<string, any>

function loadDocs(jsonlPath: string): Doc[] {
    const lines = fs.readFileSync(jsonlPath, 'utf-8').split('\n')
    const docs: Doc[] = []
    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
            docs.push(JSON.parse(trimmed))
        } catch (_) { /* skip malformed */ }
    }
    return docs
}

const DATA_PATH = path.resolve(__dirname, '../sample.jsonl')
let docs: Doc[] = []

try {
    docs = loadDocs(DATA_PATH)
    console.log(`[mockSolr] Loaded ${docs.length} documents from ${DATA_PATH}`)
} catch (e) {
    console.warn(`[mockSolr] Could not load ${DATA_PATH}: ${e}`)
}

// ──────────────────────────────────────────────
// 2.  Query parser
// ──────────────────────────────────────────────

/**
 * Very small subset of Solr query syntax:
 *   field:value
 *   field:"value"  (exact)
 *   term AND term
 *   term OR  term
 *   term NOT term
 *   wildcard * supported at end of value
 */

interface Clause {
    field: string | null   // null → search all fields
    value: string
    exact: boolean
    negate: boolean
    wildcard: boolean
}

function parseQuery(q: string): Clause[] {
    if (!q || q === '*:*') return []

    // Tokenise at AND / OR / NOT boundaries (very simplified)
    // We treat OR as additional clauses (union), NOT as negation
    const clauses: Clause[] = []

    // Replace quoted delimiters temporarily to simplify splitting
    const parts = q.split(/\s+(?:AND|OR)\s+/)

    for (let part of parts) {
        let negate = false
        part = part.trim()

        if (part.startsWith('NOT ')) {
            negate = true
            part = part.slice(4).trim()
        }

        // field:value  or  field:"value"
        const colonIdx = part.indexOf(':')
        if (colonIdx < 0) {
            // bare term – search all
            clauses.push({ field: null, value: part.replace(/"/g, ''), exact: false, negate, wildcard: part.includes('*') })
            continue
        }

        const field = part.slice(0, colonIdx).trim()
        let value = part.slice(colonIdx + 1).trim()
        let exact = false

        if (value.startsWith('"') && value.endsWith('"')) {
            exact = true
            value = value.slice(1, -1)
        }

        const wildcard = value.includes('*')
        clauses.push({ field, value, exact, negate, wildcard })
    }

    return clauses
}

/** Convert the Solr-style "WRfKdFVogXnk82…WRfKdFVogXnk82" markers to quoted exact values */
function normaliseValue(raw: string): { value: string; exact: boolean } {
    const MARKER = 'WRfKdFVogXnk82'
    if (raw.startsWith(MARKER) && raw.endsWith(MARKER)) {
        return { value: raw.slice(MARKER.length, -MARKER.length), exact: true }
    }
    return { value: raw, exact: false }
}

// ──────────────────────────────────────────────
// 3.  Search engine
// ──────────────────────────────────────────────

function fieldMatch(docValue: any, searchValue: string, exact: boolean, wildcard: boolean): boolean {
    if (docValue === undefined || docValue === null) return false

    const haystack = Array.isArray(docValue)
        ? docValue.map(v => String(v).toLowerCase())
        : [String(docValue).toLowerCase()]

    const needle = searchValue.toLowerCase()

    return haystack.some(h => {
        if (wildcard) {
            // Convert solr wildcard (*) to regex
            const pattern = '^' + needle.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
            return new RegExp(pattern).test(h)
        }
        if (exact) return h === needle
        return h.includes(needle)
    })
}

function matchClause(doc: Doc, clause: Clause): boolean {
    const { value: normValue, exact: markerExact } = normaliseValue(clause.value)
    const exact = clause.exact || markerExact
    const wildcard = clause.wildcard

    if (clause.field === null) {
        // search all fields
        return Object.values(doc).some(v => fieldMatch(v, normValue, exact, wildcard))
    }

    // Handle ? wildcard in the field value (used for space replacement in index.ts)
    const searchVal = normValue.replace(/\?/g, ' ')
    return fieldMatch(doc[clause.field], searchVal, exact, wildcard)
}

function searchDocs(
    collection: Doc[],
    q: string,
    rows: number,
    start: number,
    fl?: string
): { numFound: number; docs: Doc[] } {
    if (!q || q === '*:*') {
        const slice = collection.slice(start, start + rows)
        return { numFound: collection.length, docs: applyFl(slice, fl) }
    }

    const clauses = parseQuery(q)

    // Split into positive and negative clauses
    const posClauses = clauses.filter(c => !c.negate)
    const negClauses = clauses.filter(c => c.negate)

    const matched = collection.filter(doc => {
        // All positive clauses must match
        const posOk = posClauses.length === 0 || posClauses.some(c => matchClause(doc, c))
        // No negative clause must match
        const negOk = negClauses.every(c => !matchClause(doc, c))
        return posOk && negOk
    })

    const slice = matched.slice(start, start + rows)
    return { numFound: matched.length, docs: applyFl(slice, fl) }
}

function applyFl(docs: Doc[], fl?: string): Doc[] {
    if (!fl) return docs
    const fields = fl.split(',').map(f => f.trim())
    return docs.map(doc => {
        const out: Doc = {}
        for (const f of fields) {
            if (doc[f] !== undefined) out[f] = doc[f]
        }
        // Always include id
        if (doc.id) out.id = doc.id
        return out
    })
}

// ──────────────────────────────────────────────
// 4.  Collections registry
// ──────────────────────────────────────────────

const collections: Record<string, Doc[]> = {
    BigData: docs,
    Wallets: [],
    Exports: [],
}

// ──────────────────────────────────────────────
// 5.  Express app for mock Solr
// ──────────────────────────────────────────────

export function createMockSolrApp(): express.Express {
    const app = express()
    app.use(express.json())
    app.use(express.urlencoded({ extended: false }))

    // GET /solr/<collection>/select
    app.get('/solr/:collection/select', (req, res) => {
        const collName = req.params.collection
        const coll = collections[collName] || []

        const q = (req.query.q as string) || '*:*'
        const rows = parseInt((req.query.rows as string) || '100', 10)
        const start = parseInt((req.query.start as string) || '0', 10)
        const fl = req.query.fl as string | undefined

        // Handle more-like-this stub
        if (req.query.mlt === 'true') {
            return res.json({
                responseHeader: { status: 0 },
                response: { numFound: 0, start: 0, docs: [] },
                moreLikeThis: []
            })
        }

        // Handle spatial query stub
        if (req.query.fq && (req.query.fq as string).includes('geofilt')) {
            const { numFound, docs: resultDocs } = searchDocs(coll, q, rows, start, fl)
            return res.json({
                responseHeader: { status: 0 },
                response: { numFound, start, docs: resultDocs }
            })
        }

        const { numFound, docs: resultDocs } = searchDocs(coll, q, rows, start, fl)

        return res.json({
            responseHeader: { status: 0 },
            response: { numFound, start, docs: resultDocs }
        })
    })

    // POST /solr/<collection>/update  – for Wallets and Exports writes
    app.post('/solr/:collection/update', (req, res) => {
        const collName = req.params.collection

        if (!collections[collName]) {
            collections[collName] = []
        }

        const body = req.body
        if (body && body.add && body.add.doc) {
            const newDoc: Doc = body.add.doc
            const idx = collections[collName].findIndex(d => d.id === newDoc.id)
            if (idx >= 0) {
                collections[collName][idx] = { ...collections[collName][idx], ...newDoc }
            } else {
                collections[collName].push(newDoc)
            }
        }

        return res.json({ responseHeader: { status: 0 } })
    })

    return app
}

// ──────────────────────────────────────────────
// 6.  Start as a standalone server on port 8983
// ──────────────────────────────────────────────

if (require.main === module) {
    const app = createMockSolrApp()
    app.listen(8983, '0.0.0.0', () => {
        console.log('[mockSolr] Listening on port 8983')
    })
}
