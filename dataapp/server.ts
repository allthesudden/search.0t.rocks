/**
 * server.ts  – unified entry point for the demo
 *
 * 1.  Spins up the mock-Solr Express app on port 8983 (same host)
 * 2.  Patches axios so all calls to `solr1:8983` are redirected to
 *     `127.0.0.1:8983` (where the mock Solr is listening)
 * 3.  Requires ./index which boots the main dataapp on port 3000
 *
 * Run with:  npx ts-node server.ts
 */

import http from 'http'
import { createMockSolrApp } from './mockSolr'

// ── 1. Start the mock-Solr server on 127.0.0.1:8983 ─────────────────────────
const solrApp = createMockSolrApp()
const solrServer = http.createServer(solrApp)
solrServer.listen(8983, '127.0.0.1', () => {
    console.log('[mockSolr] Listening on http://127.0.0.1:8983')
})

// ── 2. Redirect axios calls from solr1:8983 → 127.0.0.1:8983 ────────────────
//    We do this by patching axios *before* index.ts is loaded.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require('axios')

axios.interceptors.request.use((config: any) => {
    if (config.url && config.url.includes('solr1')) {
        config.url = config.url.replace(/solr1/g, '127.0.0.1')
    }
    if (config.baseURL && config.baseURL.includes('solr1')) {
        config.baseURL = config.baseURL.replace(/solr1/g, '127.0.0.1')
    }
    return config
})

// ── 3. Boot the main application ─────────────────────────────────────────────
require('./index')
