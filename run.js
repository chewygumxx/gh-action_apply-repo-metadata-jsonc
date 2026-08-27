// vim:set expandtab shiftwidth=4 filetype=javascript:
// SPDX-License-Identifier: GPL-3.0-only

// 
// 
// ~chewygumxx/gh-action_apply-repo-metadata-jsonc.git
// ::: :/run.js
// 
// 

//
// Applies metadata to a repository according to :/.repo-metadata.jsonc
//

const fs    = require("node:fs");
const URL   = require("node:url").URL;
const path  = require("node:path");

const Ajv         = require("ajv/dist/2020");
const addFormats  = require("ajv-formats");
const jsoncParser = require("jsonc-parser");

function validURL(url) {
    try{ new URL(url); return url; } catch { return false; }
}

function fmt(val) {
    return typeof val === 'string' ? val : JSON.stringify(val, null, 2);
}

function envParse(env) {
    const ghAPIURL = validURL(env.GITHUB_API_URL);
    if (!ghAPIURL) {
        console.error(
            "[FATAL] Environment variable missing or invalid: GITHUB_API_URL",
            `GITHUB_API_URL: ${env.GITHUB_API_URL}`
        );
        process.exit(1);
    }

    const token = env.GITHUB_TOKEN;
    if (!token) {
        console.error("[FATAL] Environment variable not set: GITHUB_TOKEN");
        process.exit(1);
    }

    const slug = env.GITHUB_REPOSITORY;
    if (!slug) {
        console.error("[FATAL] Environment variable not set: GITHUB_REPOSITORY");
        process.exit(1);
    }

    const metadataPath = env.METADATA_PATH  || ".repo-metadata.jsonc";
    const absolutePath = path.isAbsolute(metadataPath) ? metadataPath : path.join(process.cwd(), metadataPath);
    if (!fs.existsSync(absolutePath)) {
        console.log("[INFO] No metadata file found at:", absolutePath);
        process.exit(0);
    }
    const metadata = jsoncParser.parse(fs.readFileSync(absolutePath, 'utf8'));

    return {
        ghAPIURL: ghAPIURL,
        token:    token,
        slug:     slug,
        metadata: metadata,
    };
}

async function metaParse(meta) {
    // Fetch JSONschema
    if (!validURL(meta.$schema)) throw new Error(
        `Failed to validate URL of metadata JSONschema: ${meta.$schema}`
    );
    const response = await fetch(meta.$schema);
    const text = await response.text();
    let schema;
    try { schema = text ? JSON.parse(text) : null; } catch { schema = text; }
    if (!response.ok) throw new Error([ 
        "Error returned when fetching metadata JSONschema:",
        `.repo-metadata.jsonc -> $schema: ${meta.$schema}`,
        `HTTP GET Response: [${response.status}] ${response.statusText}`,
        fmt(schema)
    ].join('\n'));

    // Validate
    const ajv      = new Ajv();
    addFormats(ajv);
    const validate = ajv.compile(schema);
    if (!validate(meta)) throw new Error([
        `Failed to validate metadata against: ${meta.$schema}`,
        fmt(validate.errors)
    ].join('\n'));
    console.log("[INFO] Validated metadata successfully");

    // Parse
    return {
        description: meta.description,
        homepage:    meta.homepage,
        topics:      meta.keywords
    }
};

async function ghFetch(env, apiPath, method = 'GET', body = null) {
    const headers = {
        'Authorization': `token ${env.token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'apply-repo-metadata-jsonc-action'
    };
    if (body !== null) {
        headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(env.ghAPIURL + apiPath, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined
    });

    const text = await response.text();

    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!response.ok) {
        throw new Error([ 
            `Error returned when calling ${env.ghAPIURL}${apiPath}:`,
            `GitHub API: [${response.status}] ${response.statusText}`,
            fmt(json)
        ].join('\n'));
    }

    return json;
}

function log_update(key, val) {
    console.log(`[INFO] Updated repository ${key}:`, val);
}

async function main() {
    const env  =  envParse(process.env);

    let repo;
    try {
        repo = await metaParse(env.metadata);
    } catch (err) {
        console.error("[FATAL] Failed to parse metadata:", err.message || err);
        process.exit(1);
    }

    try {
        // Update description & homepage (PATCH /repos/{owner}/{repo})
        if (repo.description || repo.homepage) {
            await ghFetch(env, `/repos/${env.slug}`, 'PATCH', {
                description: repo.description,
                homepage:    repo.homepage
            });
            if(repo.description) log_update("description", repo.description);
            if(repo.homepage)    log_update("homepage",    repo.homepage);
        }

        // Update topics (PUT /repos/{owner}/{repo}/topics)
        if (repo.topics) {
            await ghFetch(env, `/repos/${env.slug}/topics`, 'PUT', { names: repo.topics });
            log_update("topics", repo.topics.join(', '));
        }

        console.log('[NOTICE] Repository metadata update completed successfully.');
    } catch (err) {
        console.error("[FATAL] Failed to apply repository metadata:", err.message || err);
        process.exit(1);
    }
}

main();
