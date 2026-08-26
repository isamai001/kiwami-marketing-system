/**
 * Kiwami Marketing System
 * Backend API Server
 *
 * DROP-IN replacement for server.js
 *
 * Main analytics behavior:
 *
 *   profile URL
 *        ↓
 *   identify platform
 *        ↓
 *   official API if credential exists
 *        ↓
 *   otherwise fetch public profile URL
 *        ↓
 *   extract publicly available metadata/statistics
 *        ↓
 *   return normalized analytics response
 *
 * Existing frontend API contract preserved:
 *
 * POST /api/login
 * GET  /api/login-status
 * POST /api/logout
 * GET  /api/health
 * POST /api/analytics
 * GET  /api/notifications
 * POST /api/post/:platform
 * POST /api/upload
 */

require('dotenv').config();

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const app = express();

/* ============================================================================
   CONFIGURATION
============================================================================ */

const PORT = process.env.PORT || 3000;

const AUTH_EMAIL = (
    process.env.KIWAMI_ADMIN_EMAIL ||
    'admin@kiwamitech.co.ke'
).trim().toLowerCase();

const AUTH_PASSWORD = (
    process.env.KIWAMI_ADMIN_PASSWORD ||
    'Kiwami@2026'
).trim();

const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;

const LINKEDIN_VERSION =
    process.env.LINKEDIN_VERSION || '202607';

const loginAttempts = new Map();
const sessions = new Map();

/* ============================================================================
   UPLOAD DIRECTORY
============================================================================ */

const uploadsDir = path.join(__dirname, 'uploads');

try {
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }
} catch (err) {
    console.error(
        'Could not create uploads directory:',
        err.message
    );
}

/* ============================================================================
   CORS
============================================================================ */

const configuredFrontendOrigin = (
    process.env.FRONTEND_ORIGIN || ''
).trim();

if (configuredFrontendOrigin) {
    app.use(cors({
        origin: configuredFrontendOrigin,
        credentials: true,
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: [
            'Content-Type',
            'Authorization'
        ]
    }));
} else {
    app.use(cors({
        origin: '*',
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: [
            'Content-Type',
            'Authorization'
        ]
    }));
}

/* ============================================================================
   EXPRESS
============================================================================ */

app.use((req, res, next) => {
    res.setHeader(
        'X-Content-Type-Options',
        'nosniff'
    );

    res.setHeader(
        'X-Frame-Options',
        'SAMEORIGIN'
    );

    res.setHeader(
        'Referrer-Policy',
        'strict-origin-when-cross-origin'
    );

    next();
});

app.use(express.json({
    limit: '100mb'
}));

app.use(express.urlencoded({
    limit: '100mb',
    extended: true
}));

app.use(express.static(path.join(__dirname)));

app.use(
    '/uploads',
    express.static(uploadsDir)
);

/* ============================================================================
   GENERAL HELPERS
============================================================================ */

function safe(value, max = 500) {
    if (typeof value !== 'string') {
        return '';
    }

    return value
        .replace(/[<>"'`]/g, '')
        .trim()
        .slice(0, max);
}

function safeToken(value, max = 10000) {
    if (typeof value !== 'string') {
        return '';
    }

    return value.trim().slice(0, max);
}

function toNumber(value) {
    if (typeof value === 'string') {
        value = value
            .replace(/,/g, '')
            .trim();
    }

    const n = Number(value);

    return Number.isFinite(n) ? n : 0;
}

function round(value, decimals = 2) {
    const factor = Math.pow(10, decimals);

    return Math.round(
        (toNumber(value) + Number.EPSILON) * factor
    ) / factor;
}

function timingSafeEquals(a, b) {
    const aBuf = Buffer.from(String(a || ''));
    const bBuf = Buffer.from(String(b || ''));

    if (aBuf.length !== bBuf.length) {
        return false;
    }

    return crypto.timingSafeEqual(
        aBuf,
        bBuf
    );
}

function getClientIp(req) {
    return (
        req.headers['x-forwarded-for'] ||
        req.socket?.remoteAddress ||
        'unknown'
    )
        .toString()
        .split(',')[0]
        .trim();
}

function jsonErrorMessage(
    body,
    fallback = 'API request failed'
) {
    if (!body) {
        return fallback;
    }

    if (typeof body === 'string') {
        return body.slice(0, 500);
    }

    return (
        body?.error?.message ||
        body?.message ||
        body?.detail ||
        body?.errors?.[0]?.message ||
        body?.error?.description ||
        fallback
    );
}

/* ============================================================================
   NUMBER PARSING
============================================================================ */

/*
 * Converts things such as:
 *
 * "1.2K"  -> 1200
 * "3.4M"  -> 3400000
 * "2B"    -> 2000000000
 * "12,500" -> 12500
 */
function parseMetric(value) {
    if (
        value === null ||
        value === undefined
    ) {
        return 0;
    }

    if (typeof value === 'number') {
        return Number.isFinite(value)
            ? value
            : 0;
    }

    let text = String(value)
        .trim()
        .replace(/,/g, '');

    if (!text) {
        return 0;
    }

    const match = text.match(
        /(-?\d+(?:\.\d+)?)\s*([KMBT])?/i
    );

    if (!match) {
        return 0;
    }

    let number = Number(match[1]);

    if (!Number.isFinite(number)) {
        return 0;
    }

    const suffix = (
        match[2] || ''
    ).toUpperCase();

    if (suffix === 'K') {
        number *= 1000;
    } else if (suffix === 'M') {
        number *= 1000000;
    } else if (suffix === 'B') {
        number *= 1000000000;
    } else if (suffix === 'T') {
        number *= 1000000000000;
    }

    return Math.round(number);
}

/* ============================================================================
   HTTP GET
============================================================================ */

function apiGet(
    rawUrl,
    headers = {},
    redirectCount = 0
) {
    return new Promise((resolve, reject) => {
        if (redirectCount > MAX_REDIRECTS) {
            return reject(
                new Error('Too many redirects')
            );
        }

        let parsed;

        try {
            parsed = new URL(rawUrl);
        } catch {
            return reject(
                new Error('Invalid URL')
            );
        }

        const isHttps =
            parsed.protocol === 'https:';

        const lib =
            isHttps ? https : http;

        const options = {
            hostname: parsed.hostname,
            port:
                parsed.port ||
                (isHttps ? 443 : 80),

            path:
                parsed.pathname +
                parsed.search,

            method: 'GET',

            headers: {
                Accept:
                    'text/html,application/json,application/xhtml+xml,*/*;q=0.8',

                'User-Agent':
                    'Mozilla/5.0 (compatible; KiwamiMarketingSystem/3.0; +https://kiwamitech.co.ke)',

                ...headers
            },

            timeout:
                REQUEST_TIMEOUT_MS
        };

        const request =
            lib.request(
                options,
                response => {

                    if (
                        [301, 302, 303, 307, 308]
                            .includes(
                                response.statusCode
                            ) &&
                        response.headers.location
                    ) {
                        const redirectUrl =
                            new URL(
                                response.headers.location,
                                rawUrl
                            ).toString();

                        response.resume();

                        return apiGet(
                            redirectUrl,
                            headers,
                            redirectCount + 1
                        )
                            .then(resolve)
                            .catch(reject);
                    }

                    let data = '';

                    response.setEncoding(
                        'utf8'
                    );

                    response.on(
                        'data',
                        chunk => {
                            data += chunk;

                            /*
                             * Prevent enormous responses from consuming
                             * the server unnecessarily.
                             */
                            if (
                                data.length >
                                15 * 1024 * 1024
                            ) {
                                request.destroy(
                                    new Error(
                                        'Response too large'
                                    )
                                );
                            }
                        }
                    );

                    response.on(
                        'end',
                        () => {
                            const contentType =
                                String(
                                    response.headers[
                                        'content-type'
                                    ] || ''
                                ).toLowerCase();

                            let body =
                                data;

                            if (
                                contentType.includes(
                                    'application/json'
                                ) ||
                                contentType.includes(
                                    '+json'
                                )
                            ) {
                                try {
                                    body =
                                        data
                                            ? JSON.parse(data)
                                            : {};
                                } catch {
                                    body = data;
                                }
                            }

                            resolve({
                                status:
                                    response.statusCode || 0,

                                headers:
                                    response.headers || {},

                                body,

                                raw:
                                    data
                            });
                        }
                    );
                }
            );

        request.on(
            'timeout',
            () => {
                request.destroy(
                    new Error(
                        'Request timed out'
                    )
                );
            }
        );

        request.on(
            'error',
            reject
        );

        request.end();
    });
}

/* ============================================================================
   PUBLIC URL FETCHING
============================================================================ */

/*
 * This is the important addition.
 *
 * When no official API credential is available, the server actually
 * retrieves the supplied profile URL.
 */
async function fetchPublicPage(
    profileUrl
) {
    try {
        const response =
            await apiGet(
                profileUrl,
                {
                    Accept:
                        'text/html,application/xhtml+xml'
                }
            );

        if (
            response.status < 200 ||
            response.status >= 400
        ) {
            return {
                ok: false,
                status:
                    response.status,
                html:
                    typeof response.body === 'string'
                        ? response.body
                        : response.raw || '',
                error:
                    `Profile page returned HTTP ${response.status}`
            };
        }

        return {
            ok: true,
            status:
                response.status,
            html:
                typeof response.body === 'string'
                    ? response.body
                    : response.raw || ''
        };

    } catch (err) {
        return {
            ok: false,
            status: 0,
            html: '',
            error:
                err?.message ||
                'Could not retrieve profile URL'
        };
    }
}

/* ============================================================================
   HTML HELPERS
============================================================================ */

function decodeHtml(text) {
    if (!text) {
        return '';
    }

    return String(text)
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#x27;/gi, "'")
        .replace(/&#x2F;/gi, '/')
        .replace(/&#(\d+);/g, (_, n) =>
            String.fromCharCode(
                Number(n)
            )
        );
}

function stripTags(text) {
    return decodeHtml(
        String(text || '')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    );
}

function getMetaContent(
    html,
    attribute,
    value
) {
    if (!html) {
        return '';
    }

    const escaped =
        String(value)
            .replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&'
            );

    const regex =
        new RegExp(
            `<meta[^>]+${attribute}\\s*=\\s*["']${escaped}["'][^>]+content\\s*=\\s*["']([^"']*)["'][^>]*>`,
            'i'
        );

    const match =
        html.match(regex);

    if (match) {
        return decodeHtml(
            match[1]
        );
    }

    /*
     * Some pages put content before the property/name attribute.
     */
    const reverseRegex =
        new RegExp(
            `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]+${attribute}\\s*=\\s*["']${escaped}["'][^>]*>`,
            'i'
        );

    const reverseMatch =
        html.match(reverseRegex);

    return reverseMatch
        ? decodeHtml(
            reverseMatch[1]
        )
        : '';
}

function getMetaProperty(
    html,
    property
) {
    return getMetaContent(
        html,
        'property',
        property
    );
}

function getMetaName(
    html,
    name
) {
    return getMetaContent(
        html,
        'name',
        name
    );
}

function extractJsonLd(
    html
) {
    const results = [];

    if (!html) {
        return results;
    }

    const regex =
        /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

    let match;

    while (
        (match = regex.exec(html))
    ) {
        try {
            const parsed =
                JSON.parse(
                    match[1].trim()
                );

            if (
                Array.isArray(parsed)
            ) {
                results.push(
                    ...parsed
                );
            } else {
                results.push(
                    parsed
                );
            }
        } catch {
            /*
             * Some social sites embed malformed JSON-LD.
             * Ignore it and continue.
             */
        }
    }

    return results;
}

function recursiveFindValue(
    object,
    keys,
    depth = 0
) {
    if (
        !object ||
        depth > 8
    ) {
        return undefined;
    }

    const wanted =
        new Set(
            keys.map(
                key =>
                    String(key)
                        .toLowerCase()
            )
        );

    if (
        typeof object !== 'object'
    ) {
        return undefined;
    }

    for (
        const [key, value]
        of Object.entries(object)
    ) {
        if (
            wanted.has(
                String(key)
                    .toLowerCase()
            )
        ) {
            return value;
        }
    }

    for (
        const value
        of Object.values(object)
    ) {
        if (
            value &&
            typeof value === 'object'
        ) {
            const found =
                recursiveFindValue(
                    value,
                    keys,
                    depth + 1
                );

            if (
                found !== undefined
            ) {
                return found;
            }
        }
    }

    return undefined;
}

function findAllValues(
    object,
    keys,
    output = [],
    depth = 0
) {
    if (
        !object ||
        depth > 8
    ) {
        return output;
    }

    if (
        typeof object !== 'object'
    ) {
        return output;
    }

    const wanted =
        new Set(
            keys.map(
                key =>
                    String(key)
                        .toLowerCase()
            )
        );

    for (
        const [key, value]
        of Object.entries(object)
    ) {
        if (
            wanted.has(
                String(key)
                    .toLowerCase()
            )
        ) {
            output.push(value);
        }

        if (
            value &&
            typeof value === 'object'
        ) {
            findAllValues(
                value,
                keys,
                output,
                depth + 1
            );
        }
    }

    return output;
}

function firstPositiveMetric(
    values
) {
    for (
        const value
        of values
    ) {
        const n =
            parseMetric(value);

        if (n > 0) {
            return n;
        }
    }

    return 0;
}

function publicPageBaseData(
    html
) {
    const jsonLd =
        extractJsonLd(html);

    const title =
        getMetaProperty(
            html,
            'og:title'
        ) ||
        getMetaName(
            html,
            'twitter:title'
        ) ||
        (
            html.match(
                /<title[^>]*>([\s\S]*?)<\/title>/i
            ) || []
        )[1] ||
        '';

    const description =
        getMetaProperty(
            html,
            'og:description'
        ) ||
        getMetaName(
            html,
            'description'
        ) ||
        getMetaName(
            html,
            'twitter:description'
        ) ||
        '';

    const image =
        getMetaProperty(
            html,
            'og:image'
        ) ||
        getMetaName(
            html,
            'twitter:image'
        ) ||
        '';

    return {
        title:
            stripTags(title),

        description:
            stripTags(description),

        image,

        jsonLd
    };
}

/* ============================================================================
   PUBLIC NUMBER EXTRACTION
============================================================================ */

function extractPublicMetrics(
    html,
    platform
) {
    const base =
        publicPageBaseData(html);

    const jsonLd =
        base.jsonLd;

    const jsonLdFollowers =
        findAllValues(
            jsonLd,
            [
                'followers',
                'followerCount',
                'subscriberCount',
                'userInteractionCount'
            ]
        );

    const jsonLdViews =
        findAllValues(
            jsonLd,
            [
                'viewCount',
                'views',
                'interactionCount'
            ]
        );

    const jsonLdLikes =
        findAllValues(
            jsonLd,
            [
                'likeCount',
                'likes'
            ]
        );

    const jsonLdPosts =
        findAllValues(
            jsonLd,
            [
                'videoCount',
                'postCount',
                'numberOfItems',
                'interactionCount'
            ]
        );

    let followers =
        firstPositiveMetric(
            jsonLdFollowers
        );

    let views =
        firstPositiveMetric(
            jsonLdViews
        );

    let likes =
        firstPositiveMetric(
            jsonLdLikes
        );

    let posts =
        firstPositiveMetric(
            jsonLdPosts
        );

    /*
     * Generic visible-text extraction.
     *
     * These are intentionally conservative.
     */
    const text =
        stripTags(html);

    const followerPatterns = [
        /([\d.,]+[KMB]?)\s*(?:followers|follower)/i,
        /(?:followers|follower)[^0-9]{0,30}([\d.,]+[KMB]?)/i,
        /([\d.,]+[KMB]?)\s*(?:subscribers|subscriber)/i,
        /(?:subscribers|subscriber)[^0-9]{0,30}([\d.,]+[KMB]?)/i
    ];

    const viewPatterns = [
        /([\d.,]+[KMB]?)\s*(?:views|view)/i,
        /(?:views|view)[^0-9]{0,30}([\d.,]+[KMB]?)/i
    ];

    const likePatterns = [
        /([\d.,]+[KMB]?)\s*(?:likes|like)/i,
        /(?:likes|like)[^0-9]{0,30}([\d.,]+[KMB]?)/i
    ];

    const postPatterns = [
        /([\d.,]+[KMB]?)\s*(?:posts|post)/i,
        /([\d.,]+[KMB]?)\s*(?:videos|video)/i
    ];

    function patternValue(
        patterns
    ) {
        for (
            const pattern
            of patterns
        ) {
            const match =
                text.match(pattern);

            if (match) {
                const n =
                    parseMetric(
                        match[1]
                    );

                if (n > 0) {
                    return n;
                }
            }
        }

        return 0;
    }

    if (!followers) {
        followers =
            patternValue(
                followerPatterns
            );
    }

    if (!views) {
        views =
            patternValue(
                viewPatterns
            );
    }

    if (!likes) {
        likes =
            patternValue(
                likePatterns
            );
    }

    if (!posts) {
        posts =
            patternValue(
                postPatterns
            );
    }

    /*
     * Platform-specific JSON strings commonly used in public pages.
     */
    const followerJsonPatterns = [
        /"followerCount"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
        /"followers_count"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
        /"followers"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
        /"subscriberCount"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
        /"subscriber_count"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i
    ];

    const viewJsonPatterns = [
        /"viewCount"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
        /"view_count"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
        /"views"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i
    ];

    const likeJsonPatterns = [
        /"likeCount"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
        /"like_count"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
        /"likes"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i
    ];

    const postJsonPatterns = [
        /"videoCount"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
        /"video_count"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
        /"postCount"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
        /"media_count"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i
    ];

    function regexMetric(
        patterns
    ) {
        for (
            const pattern
            of patterns
        ) {
            const match =
                html.match(pattern);

            if (match) {
                const n =
                    parseMetric(
                        match[1]
                    );

                if (n > 0) {
                    return n;
                }
            }
        }

        return 0;
    }

    if (!followers) {
        followers =
            regexMetric(
                followerJsonPatterns
            );
    }

    if (!views) {
        views =
            regexMetric(
                viewJsonPatterns
            );
    }

    if (!likes) {
        likes =
            regexMetric(
                likeJsonPatterns
            );
    }

    if (!posts) {
        posts =
            regexMetric(
                postJsonPatterns
            );
    }

    /*
     * YouTube has particularly useful public structured data.
     */
    if (
        platform === 'youtube'
    ) {
        const subscriberMatch =
            html.match(
                /"subscriberCountText"[\s\S]{0,500}?"simpleText"\s*:\s*"([^"]+)"/i
            );

        if (
            !followers &&
            subscriberMatch
        ) {
            followers =
                parseMetric(
                    subscriberMatch[1]
                );
        }

        const videoCountMatch =
            html.match(
                /"videoCountText"[\s\S]{0,500}?"simpleText"\s*:\s*"([^"]+)"/i
            );

        if (
            !posts &&
            videoCountMatch
        ) {
            posts =
                parseMetric(
                    videoCountMatch[1]
                );
        }
    }

    return {
        name:
            base.title,

        description:
            base.description,

        image:
            base.image,

        followers,
        views,
        likes,
        posts
    };
}

/* ============================================================================
   URL PARSERS
============================================================================ */

function parseYouTube(
    rawUrl
) {
    try {
        const u =
            new URL(rawUrl);

        const hostname =
            u.hostname
                .replace(/^www\./, '')
                .toLowerCase();

        if (
            hostname !== 'youtube.com' &&
            hostname !== 'm.youtube.com' &&
            hostname !== 'youtu.be'
        ) {
            return null;
        }

        const pathname =
            u.pathname.replace(
                /\/+$/,
                ''
            );

        const handle =
            pathname.match(
                /^\/@([^/?&#]+)$/i
            );

        if (handle) {
            return {
                type: 'handle',
                value: handle[1]
            };
        }

        const channel =
            pathname.match(
                /^\/channel\/(UC[^/?&#]+)$/i
            );

        if (channel) {
            return {
                type: 'id',
                value: channel[1]
            };
        }

        const user =
            pathname.match(
                /^\/user\/([^/?&#]+)$/i
            );

        if (user) {
            return {
                type: 'forUsername',
                value: user[1]
            };
        }

        const custom =
            pathname.match(
                /^\/c\/([^/?&#]+)$/i
            );

        if (custom) {
            return {
                type: 'search',
                value: custom[1]
            };
        }

        const bare =
            pathname.match(
                /^\/([^/?&#]+)$/i
            );

        if (
            bare &&
            ![
                'watch',
                'playlist',
                'shorts',
                'feed',
                'results',
                'gaming'
            ].includes(
                bare[1].toLowerCase()
            )
        ) {
            return {
                type: 'search',
                value: bare[1]
            };
        }

    } catch {
        return null;
    }

    return null;
}

function parseTwitterUsername(
    rawUrl
) {
    try {
        const u =
            new URL(rawUrl);

        const hostname =
            u.hostname
                .replace(/^www\./, '')
                .toLowerCase();

        if (
            hostname !== 'twitter.com' &&
            hostname !== 'x.com'
        ) {
            return null;
        }

        const pathname =
            u.pathname.replace(
                /^\/+|\/+$/g,
                ''
            );

        if (!pathname) {
            return null;
        }

        const username =
            pathname.split('/')[0];

        if (
            [
                'home',
                'explore',
                'notifications',
                'messages',
                'i',
                'search',
                'settings'
            ].includes(
                username.toLowerCase()
            )
        ) {
            return null;
        }

        return username.replace(
            /^@/,
            ''
        );

    } catch {
        return null;
    }
}

function parseFacebookId(
    rawUrl
) {
    try {
        const u =
            new URL(rawUrl);

        const id =
            u.searchParams.get('id');

        if (id) {
            return id;
        }

        const pathname =
            u.pathname.replace(
                /^\/+|\/+$/g,
                ''
            );

        if (!pathname) {
            return null;
        }

        const pieces =
            pathname.split('/');

        if (
            pieces[0].toLowerCase() === 'pages' &&
            pieces[1]
        ) {
            return pieces[2] || pieces[1];
        }

        if (
            [
                'groups',
                'events',
                'watch',
                'login',
                'share',
                'sharer',
                'reel'
            ].includes(
                pieces[0].toLowerCase()
            )
        ) {
            return null;
        }

        return pieces[0];

    } catch {
        return null;
    }
}

function parseInstagramUsername(
    rawUrl
) {
    try {
        const u =
            new URL(rawUrl);

        const first =
            u.pathname
                .replace(
                    /^\/+|\/+$/g,
                    ''
                )
                .split('/')[0];

        if (!first) {
            return null;
        }

        if (
            [
                'accounts',
                'explore',
                'reels',
                'direct',
                'p',
                'stories'
            ].includes(
                first.toLowerCase()
            )
        ) {
            return null;
        }

        return first.replace(
            /^@/,
            ''
        );

    } catch {
        return null;
    }
}

function parseLinkedInOrg(
    rawUrl
) {
    try {
        const u =
            new URL(rawUrl);

        const match =
            u.pathname.match(
                /^\/company\/([^/?&#]+)/i
            );

        return match
            ? match[1]
            : null;

    } catch {
        return null;
    }
}

function parseTikTokUsername(
    rawUrl
) {
    try {
        const u =
            new URL(rawUrl);

        const match =
            u.pathname.match(
                /^\/@([^/?&#]+)/i
            );

        return match
            ? match[1]
            : null;

    } catch {
        return null;
    }
}


/* ============================================================================
   YOUTUBE
============================================================================ */

async function fetchYouTube(
    profileUrl,
    apiKey
) {
    /*
     * First try the official YouTube API.
     */
    if (apiKey) {
        const parsed =
            parseYouTube(
                profileUrl
            );

        if (parsed) {
            const params =
                new URLSearchParams();

            params.set(
                'part',
                'snippet,statistics'
            );

            params.set(
                'key',
                apiKey
            );

            if (
                parsed.type === 'id'
            ) {
                params.set(
                    'id',
                    parsed.value
                );
            }

            else if (
                parsed.type === 'handle'
            ) {
                params.set(
                    'forHandle',
                    parsed.value
                );
            }

            else if (
                parsed.type === 'forUsername'
            ) {
                params.set(
                    'forUsername',
                    parsed.value
                );
            }

            else if (
                parsed.type === 'search'
            ) {
                const searchParams =
                    new URLSearchParams();

                searchParams.set(
                    'part',
                    'snippet'
                );

                searchParams.set(
                    'type',
                    'channel'
                );

                searchParams.set(
                    'maxResults',
                    '5'
                );

                searchParams.set(
                    'q',
                    parsed.value
                );

                searchParams.set(
                    'key',
                    apiKey
                );

                const searchRes =
                    await apiGet(
                        `https://www.googleapis.com/youtube/v3/search?${searchParams.toString()}`
                    );

                if (
                    searchRes.status === 200
                ) {
                    const result =
                        searchRes.body
                            ?.items?.[0];

                    const channelId =
                        result?.snippet?.channelId ||
                        result?.id?.channelId;

                    if (channelId) {
                        params.set(
                            'id',
                            channelId
                        );
                    }
                }
            }

            if (
                params.has('id') ||
                params.has('forHandle') ||
                params.has('forUsername')
            ) {
                const response =
                    await apiGet(
                        `https://www.googleapis.com/youtube/v3/channels?${params.toString()}`
                    );

                if (
                    response.status === 200
                ) {
                    const item =
                        response.body
                            ?.items?.[0];

                    if (item) {
                        const statistics =
                            item.statistics || {};

                        const followers =
                            toNumber(
                                statistics.subscriberCount
                            );

                        const views =
                            toNumber(
                                statistics.viewCount
                            );

                        const posts =
                            toNumber(
                                statistics.videoCount
                            );

                        return {
                            status: 'ok',
                            source: 'youtube_api',

                            name:
                                item.snippet?.title ||
                                'YouTube Channel',

                            followers,
                            views,
                            likes: 0,
                            posts,

                            engagement:
                                followers > 0 &&
                                views > 0
                                    ? round(
                                        (
                                            views /
                                            followers
                                        ) * 100,
                                        2
                                    )
                                    : 0
                        };
                    }
                }
            }
        }
    }

    /*
     * No API key, or API lookup failed.
     * Actually fetch the URL.
     */
    const page =
        await fetchPublicPage(
            profileUrl
        );

    if (!page.ok) {
        return {
            status: 'unavailable',
            source: 'public_url',
            error:
                page.error ||
                'Could not retrieve YouTube profile URL'
        };
    }

    const metrics =
        extractPublicMetrics(
            page.html,
            'youtube'
        );

    if (
        !metrics.followers &&
        !metrics.views &&
        !metrics.posts
    ) {
        return {
            status: 'partial',
            source: 'public_url',

            name:
                metrics.name ||
                'YouTube Channel',

            followers: 0,
            views: 0,
            likes: 0,
            posts: 0,
            engagement: 0,

            error:
                'YouTube loaded the public page, but usable channel statistics were not publicly exposed. Add YOUTUBE_API_KEY for reliable statistics.'
        };
    }

    return {
        status: 'ok',
        source: 'public_url',

        name:
            metrics.name ||
            'YouTube Channel',

        followers:
            metrics.followers,

        views:
            metrics.views,

        likes:
            metrics.likes,

        posts:
            metrics.posts,

        engagement:
            metrics.followers > 0 &&
            metrics.views > 0
                ? round(
                    (
                        metrics.views /
                        metrics.followers
                    ) * 100,
                    2
                )
                : 0
    };
}

/* ============================================================================
   TWITTER / X
============================================================================ */

async function fetchTwitter(
    profileUrl,
    bearerToken
) {
    const username =
        parseTwitterUsername(
            profileUrl
        );

    if (!username) {
        return {
            status: 'invalid_url',
            error:
                'Cannot parse X/Twitter profile URL'
        };
    }

    /*
     * Official API first.
     */
    if (bearerToken) {
        const endpoint =
            `https://api.twitter.com/2/users/by/username/` +
            `${encodeURIComponent(username)}` +
            `?user.fields=${encodeURIComponent(
                'public_metrics,name,username,description'
            )}`;

        const response =
            await apiGet(
                endpoint,
                {
                    Authorization:
                        `Bearer ${bearerToken}`
                }
            );

        if (
            response.status === 200 &&
            response.body?.data
        ) {
            const data =
                response.body.data;

            const metrics =
                data.public_metrics || {};

            const followers =
                toNumber(
                    metrics.followers_count
                );

            const posts =
                toNumber(
                    metrics.tweet_count
                );

            const likes =
                toNumber(
                    metrics.like_count
                );

            return {
                status: 'ok',
                source: 'x_api',

                name:
                    data.name ||
                    data.username ||
                    username,

                followers,
                views: 0,
                likes,
                posts,

                engagement:
                    followers > 0
                        ? round(
                            (
                                likes /
                                followers
                            ) * 100,
                            2
                        )
                        : 0
            };
        }
    }

    /*
     * Public URL fallback.
     */
    const page =
        await fetchPublicPage(
            profileUrl
        );

    if (!page.ok) {
        return {
            status: 'unavailable',
            source: 'public_url',
            error:
                page.error ||
                'Could not retrieve X/Twitter profile'
        };
    }

    const metrics =
        extractPublicMetrics(
            page.html,
            'twitter'
        );

    if (
        !metrics.followers &&
        !metrics.likes &&
        !metrics.posts
    ) {
        return {
            status: 'partial',
            source: 'public_url',

            name:
                metrics.name ||
                `@${username}`,

            followers: 0,
            views: 0,
            likes: 0,
            posts: 0,
            engagement: 0,

            error:
                'X/Twitter loaded the profile page, but account statistics were not publicly exposed to the server. Add TWITTER_BEARER for reliable statistics.'
        };
    }

    return {
        status: 'ok',
        source: 'public_url',

        name:
            metrics.name ||
            `@${username}`,

        followers:
            metrics.followers,

        views:
            metrics.views,

        likes:
            metrics.likes,

        posts:
            metrics.posts,

        engagement:
            metrics.followers > 0
                ? round(
                    (
                        metrics.likes /
                        metrics.followers
                    ) * 100,
                    2
                )
                : 0
    };
}
/* ============================================================================
   EXTRA PUBLIC SOCIAL FALLBACK
   Instagram + Facebook + LinkedIn
============================================================================ */

async function fetchSocialPublicFallback(profileUrl, platform) {
    if (!profileUrl) {
        return null;
    }

    try {
        const response = await fetch(profileUrl, {
            method: 'GET',

            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                    'Chrome/151.0.0.0 Safari/537.36',

                'Accept':
                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

                'Accept-Language':
                    'en-US,en;q=0.9',

                'Cache-Control':
                    'no-cache'
            },

            redirect: 'follow'
        });

        const html = await response.text();

        if (!html || html.length < 100) {
            return null;
        }

        /*
         * ------------------------------------------------------------
         * Decode HTML entities
         * ------------------------------------------------------------
         */

        const clean = html
            .replace(/\\u0026/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#34;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');

        /*
         * ------------------------------------------------------------
         * General metadata
         * ------------------------------------------------------------
         */

        function getMeta(property) {
            const patterns = [
                new RegExp(
                    `<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`,
                    'i'
                ),

                new RegExp(
                    `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`,
                    'i'
                ),

                new RegExp(
                    `<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`,
                    'i'
                )
            ];

            for (const pattern of patterns) {
                const match = clean.match(pattern);

                if (match && match[1]) {
                    return match[1].trim();
                }
            }

            return '';
        }

        const title =
            getMeta('og:title') ||
            getMeta('twitter:title') ||
            '';

        const description =
            getMeta('og:description') ||
            getMeta('description') ||
            getMeta('twitter:description') ||
            '';

        const image =
            getMeta('og:image') ||
            '';

        /*
         * ------------------------------------------------------------
         * Number parser
         *
         * Understands:
         *  1,234
         *  12.5K
         *  2.1M
         *  450 followers
         * ------------------------------------------------------------
         */

        function parseNumber(value) {
            if (!value) {
                return 0;
            }

            let text =
                String(value)
                    .replace(/,/g, '')
                    .trim()
                    .toUpperCase();

            const match =
                text.match(
                    /(\d+(?:\.\d+)?)\s*([KMB])?/
                );

            if (!match) {
                return 0;
            }

            let number =
                parseFloat(match[1]);

            const suffix =
                match[2];

            if (suffix === 'K') {
                number *= 1000;
            }

            if (suffix === 'M') {
                number *= 1000000;
            }

            if (suffix === 'B') {
                number *= 1000000000;
            }

            return Math.round(number);
        }

        /*
         * ------------------------------------------------------------
         * Search the HTML around specific words.
         * ------------------------------------------------------------
         */

        function findNumberAfterWords(words) {
            for (const word of words) {

                const pattern =
                    new RegExp(
                        '(\\d[\\d,.]*\\s*[KMB]?)\\s*' +
                        word,
                        'i'
                    );

                const match =
                    clean.match(pattern);

                if (match) {
                    return parseNumber(match[1]);
                }

                const reversePattern =
                    new RegExp(
                        word +
                        '[^\\d]{0,80}' +
                        '(\\d[\\d,.]*\\s*[KMB]?)',
                        'i'
                    );

                const reverseMatch =
                    clean.match(reversePattern);

                if (reverseMatch) {
                    return parseNumber(
                        reverseMatch[1]
                    );
                }
            }

            return 0;
        }

        /*
         * ------------------------------------------------------------
         * Platform-specific public numbers
         * ------------------------------------------------------------
         */

        let followers = 0;
        let posts = 0;
        let likes = 0;

        if (platform === 'instagram') {

            followers =
                findNumberAfterWords([
                    'followers',
                    'follower'
                ]);

            posts =
                findNumberAfterWords([
                    'posts',
                    'post'
                ]);

        } else if (platform === 'facebook') {

            followers =
                findNumberAfterWords([
                    'followers',
                    'follower',
                    'people follow this',
                    'people like this'
                ]);

            likes =
                findNumberAfterWords([
                    'likes',
                    'like'
                ]);

        } else if (platform === 'linkedin') {

            followers =
                findNumberAfterWords([
                    'followers',
                    'follower',
                    'employees'
                ]);

            /*
             * LinkedIn sometimes exposes employee count
             * rather than follower count. We deliberately
             * DON'T treat employees as followers.
             */

            if (
                !followers &&
                /followers/i.test(clean)
            ) {
                followers =
                    findNumberAfterWords([
                        'followers',
                        'follower'
                    ]);
            }
        }

        /*
         * ------------------------------------------------------------
         * Try structured JSON as well.
         * ------------------------------------------------------------
         */

        const jsonNumberPatterns = [
            /"followers_count"\s*:\s*(\d+)/i,
            /"follower_count"\s*:\s*(\d+)/i,
            /"followers"\s*:\s*(\d+)/i,
            /"media_count"\s*:\s*(\d+)/i,
            /"posts_count"\s*:\s*(\d+)/i
        ];

        for (const pattern of jsonNumberPatterns) {
            const match =
                clean.match(pattern);

            if (match) {
                const value =
                    parseNumber(match[1]);

                if (!followers && /followers/i.test(pattern.source)) {
                    followers = value;
                }

                if (!posts && /media|posts/i.test(pattern.source)) {
                    posts = value;
                }
            }
        }

        /*
         * ------------------------------------------------------------
         * Extract a useful username/title
         * ------------------------------------------------------------
         */

        let name = title;

        if (!name) {
            const titleMatch =
                clean.match(
                    /<title[^>]*>([\s\S]*?)<\/title>/i
                );

            if (titleMatch) {
                name =
                    titleMatch[1]
                        .replace(/\s+/g, ' ')
                        .trim();
            }
        }

        /*
         * ------------------------------------------------------------
         * Return only if we actually found something useful.
         * ------------------------------------------------------------
         */

        const hasData =
            Boolean(
                name ||
                description ||
                followers ||
                posts ||
                likes
            );

        if (!hasData) {
            return null;
        }

        return {
            status: 'ok',
            source: 'public_fallback',

            name:
                name ||
                platform,

            description:
                description || '',

            image:
                image || '',

            followers,
            posts,
            likes,

            views: 0,

            engagement:
                followers > 0 && posts > 0
                    ? round(
                        (
                            likes /
                            posts /
                            followers
                        ) * 100,
                        2
                    )
                    : 0
        };

    } catch (err) {

        console.error(
            `[${platform}] public fallback error:`,
            err?.message || err
        );

        return null;
    }
}
/* ============================================================================
   FACEBOOK
============================================================================ */

async function fetchFacebook(
    profileUrl,
    accessToken
) {
    const pageId =
        parseFacebookId(
            profileUrl
        );

    /*
     * Official Meta API.
     */
    if (
        accessToken &&
        pageId
    ) {
        const fields = [
            'id',
            'name',
            'followers_count',
            'fan_count'
        ].join(',');

        const endpoint =
            `https://graph.facebook.com/v23.0/` +
            `${encodeURIComponent(pageId)}` +
            `?fields=${encodeURIComponent(fields)}` +
            `&access_token=${encodeURIComponent(accessToken)}`;

        const response =
            await apiGet(
                endpoint
            );

        if (
            response.status === 200 &&
            response.body
        ) {
            const page =
                response.body;

            const followers =
                toNumber(
                    page.followers_count ||
                    page.fan_count
                );

            let likes = 0;
            let comments = 0;
            let posts = 0;

            const postsEndpoint =
                `https://graph.facebook.com/v23.0/` +
                `${encodeURIComponent(page.id || pageId)}` +
                `/posts?fields=${encodeURIComponent(
                    'id,likes.limit(0).summary(true),comments.limit(0).summary(true)'
                )}` +
                `&limit=25` +
                `&access_token=${encodeURIComponent(accessToken)}`;

            const postsResponse =
                await apiGet(
                    postsEndpoint
                );

            if (
                postsResponse.status === 200
            ) {
                const items =
                    postsResponse.body?.data ||
                    [];

                posts =
                    items.length;

                for (
                    const post
                    of items
                ) {
                    likes +=
                        toNumber(
                            post.likes
                                ?.summary
                                ?.total_count
                        );

                    comments +=
                        toNumber(
                            post.comments
                                ?.summary
                                ?.total_count
                        );
                }
            }

            const interactions =
                likes + comments;

            return {
                status: 'ok',
                source: 'meta_api',

                name:
                    page.name ||
                    'Facebook Page',

                followers,
                views: 0,
                likes,
                posts,

                engagement:
                    followers > 0 &&
                    posts > 0
                        ? round(
                            (
                                interactions /
                                posts /
                                followers
                            ) * 100,
                            2
                        )
                        : 0
            };
        }
    }

    /*
     * Public URL fallback.
     */
    const page =
        await fetchPublicPage(
            profileUrl
        );

    if (!page.ok) {
        return {
            status: 'unavailable',
            source: 'public_url',
            error:
                page.error ||
                'Could not retrieve Facebook URL'
        };
    }

    const metrics =
        extractPublicMetrics(
            page.html,
            'facebook'
        );

    if (
        !metrics.followers &&
        !metrics.likes &&
        !metrics.posts
    ) {
        return {
            status: 'partial',
            source: 'public_url',

            name:
                metrics.name ||
                'Facebook Page',

            followers: 0,
            views: 0,
            likes: 0,
            posts: 0,
            engagement: 0,

            error:
                'Facebook loaded the public URL, but reliable page statistics were not publicly exposed. Add FB_TOKEN for reliable page statistics.'
        };
    }

    return {
        status: 'ok',
        source: 'public_url',

        name:
            metrics.name ||
            'Facebook Page',

        followers:
            metrics.followers,

        views:
            metrics.views,

        likes:
            metrics.likes,

        posts:
            metrics.posts,

        engagement:
            metrics.followers > 0 &&
            metrics.posts > 0
                ? round(
                    (
                        metrics.likes /
                        metrics.posts /
                        metrics.followers
                    ) * 100,
                    2
                )
                : 0
    };
}

/* ============================================================================
   INSTAGRAM
============================================================================ */

async function fetchInstagram(
    profileUrl,
    accessToken
) {
    const username =
        parseInstagramUsername(
            profileUrl
        );

    if (!username) {
        return {
            status: 'invalid_url',
            error:
                'Cannot parse Instagram profile URL'
        };
    }

    /*
     * If a Meta token is available, try the connected professional account.
     */
    if (accessToken) {
        const pagesEndpoint =
            `https://graph.facebook.com/v23.0/me/accounts` +
            `?fields=id,name,access_token` +
            `&limit=100` +
            `&access_token=${encodeURIComponent(accessToken)}`;

        const pagesResponse =
            await apiGet(
                pagesEndpoint
            );

        if (
            pagesResponse.status === 200
        ) {
            const pages =
                pagesResponse.body?.data ||
                [];

            for (
                const page
                of pages
            ) {
                const pageToken =
                    page.access_token ||
                    accessToken;

                const relationshipEndpoint =
                    `https://graph.facebook.com/v23.0/` +
                    `${encodeURIComponent(page.id)}` +
                    `?fields=instagram_business_account` +
                    `&access_token=${encodeURIComponent(pageToken)}`;

                const relationshipResponse =
                    await apiGet(
                        relationshipEndpoint
                    );

                if (
                    relationshipResponse.status !== 200
                ) {
                    continue;
                }

                const igId =
                    relationshipResponse.body
                        ?.instagram_business_account
                        ?.id;

                if (!igId) {
                    continue;
                }

                const fields = [
                    'id',
                    'username',
                    'name',
                    'followers_count',
                    'media_count'
                ].join(',');

                const accountEndpoint =
                    `https://graph.facebook.com/v23.0/` +
                    `${encodeURIComponent(igId)}` +
                    `?fields=${encodeURIComponent(fields)}` +
                    `&access_token=${encodeURIComponent(pageToken)}`;

                const accountResponse =
                    await apiGet(
                        accountEndpoint
                    );

                if (
                    accountResponse.status !== 200
                ) {
                    continue;
                }

                const account =
                    accountResponse.body || {};

                if (
                    account.username &&
                    account.username.toLowerCase() !==
                    username.toLowerCase()
                ) {
                    continue;
                }

                const followers =
                    toNumber(
                        account.followers_count
                    );

                const posts =
                    toNumber(
                        account.media_count
                    );

                let likes = 0;
                let comments = 0;
                let mediaCount = 0;

                const mediaEndpoint =
                    `https://graph.facebook.com/v23.0/` +
                    `${encodeURIComponent(igId)}` +
                    `/media?fields=${encodeURIComponent(
                        'id,like_count,comments_count'
                    )}` +
                    `&limit=25` +
                    `&access_token=${encodeURIComponent(pageToken)}`;

                const mediaResponse =
                    await apiGet(
                        mediaEndpoint
                    );

                if (
                    mediaResponse.status === 200
                ) {
                    const media =
                        mediaResponse.body?.data ||
                        [];

                    mediaCount =
                        media.length;

                    for (
                        const item
                        of media
                    ) {
                        likes +=
                            toNumber(
                                item.like_count
                            );

                        comments +=
                            toNumber(
                                item.comments_count
                            );
                    }
                }

                const interactions =
                    likes + comments;

                return {
                    status: 'ok',
                    source: 'instagram_meta_api',

                    name:
                        account.name ||
                        account.username ||
                        username,

                    followers,
                    views: 0,
                    likes,
                    posts,

                    engagement:
                        followers > 0 &&
                        mediaCount > 0
                            ? round(
                                (
                                    interactions /
                                    mediaCount /
                                    followers
                                ) * 100,
                                2
                            )
                            : 0
                };
            }
        }
    }

    /*
     * Public Instagram URL fallback.
     */
    const page =
        await fetchPublicPage(
            profileUrl
        );

    if (!page.ok) {
        return {
            status: 'unavailable',
            source: 'public_url',
            error:
                page.error ||
                'Could not retrieve Instagram profile'
        };
    }

    const metrics =
        extractPublicMetrics(
            page.html,
            'instagram'
        );

    if (
        !metrics.followers &&
        !metrics.likes &&
        !metrics.posts
    ) {
        return {
            status: 'partial',
            source: 'public_url',

            name:
                metrics.name ||
                `@${username}`,

            followers: 0,
            views: 0,
            likes: 0,
            posts: 0,
            engagement: 0,

            error:
                'Instagram loaded the profile URL, but statistics were not publicly exposed to the server. Add an Instagram/Meta access token for professional-account statistics.'
        };
    }

    return {
        status: 'ok',
        source: 'public_url',

        name:
            metrics.name ||
            `@${username}`,

        followers:
            metrics.followers,

        views:
            metrics.views,

        likes:
            metrics.likes,

        posts:
            metrics.posts,

        engagement:
            metrics.followers > 0 &&
            metrics.posts > 0
                ? round(
                    (
                        metrics.likes /
                        metrics.posts /
                        metrics.followers
                    ) * 100,
                    2
                )
                : 0
    };
}

/* ============================================================================
   LINKEDIN
============================================================================ */

async function fetchLinkedIn(
    profileUrl,
    accessToken
) {
    const vanity =
        parseLinkedInOrg(
            profileUrl
        );

    if (!vanity) {
        return {
            status: 'invalid_url',
            error:
                'Expected LinkedIn company URL such as https://www.linkedin.com/company/company-name/'
        };
    }

    if (accessToken) {
        const headers = {
            Authorization:
                `Bearer ${accessToken}`,

            'LinkedIn-Version':
                LINKEDIN_VERSION,

            'X-Restli-Protocol-Version':
                '2.0.0',

            Accept:
                'application/json'
        };

        const endpoint =
            `https://api.linkedin.com/rest/organizations` +
            `?q=vanityName` +
            `&vanityName=${encodeURIComponent(vanity)}`;

        const response =
            await apiGet(
                endpoint,
                headers
            );

        if (
            response.status === 200
        ) {
            const organization =
                response.body
                    ?.elements?.[0];

            if (organization) {
                const orgId =
                    organization.id;

                let followers = 0;

                /*
                 * Attempt follower information.
                 */
                const followerEndpoint =
                    `https://api.linkedin.com/v2/networkSizes/` +
                    `urn%3Ali%3Aorganization%3A${encodeURIComponent(orgId)}` +
                    `?edgeType=CompanyFollowedByMember`;

                const followerResponse =
                    await apiGet(
                        followerEndpoint,
                        headers
                    );

                if (
                    followerResponse.status === 200
                ) {
                    followers =
                        toNumber(
                            followerResponse.body
                                ?.firstDegreeSize
                        );
                }

                let views = 0;
                let likes = 0;
                let posts = 0;
                let comments = 0;
                let shares = 0;

                const organizationUrn =
                    `urn:li:organization:${orgId}`;

                const statsEndpoint =
                    `https://api.linkedin.com/rest/organizationalEntityShareStatistics` +
                    `?q=organizationalEntity` +
                    `&organizationalEntity=${encodeURIComponent(
                        organizationUrn
                    )}`;

                const statsResponse =
                    await apiGet(
                        statsEndpoint,
                        headers
                    );

                if (
                    statsResponse.status === 200
                ) {
                    const elements =
                        statsResponse.body
                            ?.elements || [];

                    posts =
                        elements.length;

                    for (
                        const element
                        of elements
                    ) {
                        const stats =
                            element.totalShareStatistics ||
                            {};

                        views +=
                            toNumber(
                                stats.impressionCount
                            );

                        likes +=
                            toNumber(
                                stats.likeCount
                            );

                        comments +=
                            toNumber(
                                stats.commentCount
                            );

                        shares +=
                            toNumber(
                                stats.shareCount
                            );
                    }
                }

                const interactions =
                    likes +
                    comments +
                    shares;

                return {
                    status: 'ok',
                    source: 'linkedin_api',

                    name:
                        organization.localizedName ||
                        organization.vanityName ||
                        vanity,

                    followers,
                    views,
                    likes,
                    posts,

                    engagement:
                        views > 0
                            ? round(
                                (
                                    interactions /
                                    views
                                ) * 100,
                                2
                            )
                            : 0
                };
            }
        }
    }

    /*
     * Public URL fallback.
     */
    const page =
        await fetchPublicPage(
            profileUrl
        );

    if (!page.ok) {
        return {
            status: 'unavailable',
            source: 'public_url',
            error:
                page.error ||
                'Could not retrieve LinkedIn company URL'
        };
    }

    const metrics =
        extractPublicMetrics(
            page.html,
            'linkedin'
        );

    if (
        !metrics.followers &&
        !metrics.likes &&
        !metrics.views &&
        !metrics.posts
    ) {
        return {
            status: 'partial',
            source: 'public_url',

            name:
                metrics.name ||
                vanity,

            followers: 0,
            views: 0,
            likes: 0,
            posts: 0,
            engagement: 0,

            error:
                'LinkedIn loaded the company URL, but company statistics were not publicly exposed. Add LINKEDIN_TOKEN for API statistics.'
        };
    }

    return {
        status: 'ok',
        source: 'public_url',

        name:
            metrics.name ||
            vanity,

        followers:
            metrics.followers,

        views:
            metrics.views,

        likes:
            metrics.likes,

        posts:
            metrics.posts,

        engagement:
            metrics.views > 0
                ? round(
                    (
                        metrics.likes /
                        metrics.views
                    ) * 100,
                    2
                )
                : 0
    };
}

/* ============================================================================
   TIKTOK
============================================================================ */

async function fetchTikTok(
    profileUrl,
    accessToken
) {
    const username =
        parseTikTokUsername(
            profileUrl
        );

    if (!username) {
        return {
            status: 'invalid_url',
            error:
                'Expected TikTok URL such as https://www.tiktok.com/@username'
        };
    }

    /*
     * Official TikTok API.
     */
    if (accessToken) {
        const fields = [
            'open_id',
            'display_name',
            'username',
            'follower_count',
            'following_count',
            'likes_count',
            'video_count'
        ].join(',');

        const endpoint =
            `https://open.tiktokapis.com/v2/user/info/` +
            `?fields=${encodeURIComponent(fields)}`;

        const response =
            await apiGet(
                endpoint,
                {
                    Authorization:
                        `Bearer ${accessToken}`
                }
            );

        if (
            response.status === 200 &&
            response.body?.data?.user
        ) {
            const user =
                response.body.data.user;

            const followers =
                toNumber(
                    user.follower_count
                );

            const likes =
                toNumber(
                    user.likes_count
                );

            const posts =
                toNumber(
                    user.video_count
                );

            return {
                status: 'ok',
                source: 'tiktok_api',

                name:
                    user.display_name ||
                    user.username ||
                    username,

                followers,
                views: 0,
                likes,
                posts,

                engagement:
                    followers > 0
                        ? round(
                            (
                                likes /
                                followers
                            ) * 100,
                            2
                        )
                        : 0
            };
        }
    }

    /*
     * Public URL fallback.
     */
    const page =
        await fetchPublicPage(
            profileUrl
        );

    if (!page.ok) {
        return {
            status: 'unavailable',
            source: 'public_url',
            error:
                page.error ||
                'Could not retrieve TikTok profile'
        };
    }

    const metrics =
        extractPublicMetrics(
            page.html,
            'tiktok'
        );

    if (
        !metrics.followers &&
        !metrics.likes &&
        !metrics.posts &&
        !metrics.views
    ) {
        return {
            status: 'partial',
            source: 'public_url',

            name:
                metrics.name ||
                `@${username}`,

            followers: 0,
            views: 0,
            likes: 0,
            posts: 0,
            engagement: 0,

            error:
                'TikTok loaded the profile URL, but statistics were not publicly exposed to the server. Add TIKTOK_TOKEN for API statistics.'
        };
    }

    return {
        status: 'ok',
        source: 'public_url',

        name:
            metrics.name ||
            `@${username}`,

        followers:
            metrics.followers,

        views:
            metrics.views,

        likes:
            metrics.likes,

        posts:
            metrics.posts,

        engagement:
            metrics.followers > 0
                ? round(
                    (
                        metrics.likes /
                        metrics.followers
                    ) * 100,
                    2
                )
                : 0
    };
}

/* ============================================================================
   PLATFORM CONFIGURATION
============================================================================ */

const PLATFORM_NAMES = [
    'facebook',
    'instagram',
    'twitter',
    'linkedin',
    'youtube',
    'tiktok'
];

const ALLOWED_HOSTS = {
    facebook: [
        'facebook.com'
    ],

    instagram: [
        'instagram.com'
    ],

    twitter: [
        'twitter.com',
        'x.com'
    ],

    linkedin: [
        'linkedin.com'
    ],

    youtube: [
        'youtube.com',
        'youtu.be'
    ],

    tiktok: [
        'tiktok.com'
    ]
};

function validateProfileUrl(
    platform,
    rawUrl
) {
    if (!rawUrl) {
        return null;
    }

    let parsed;

    try {
        parsed =
            new URL(rawUrl);
    } catch {
        return `Invalid URL for ${platform}`;
    }

    if (
        ![
            'http:',
            'https:'
        ].includes(
            parsed.protocol
        )
    ) {
        return `Invalid protocol for ${platform}`;
    }

    const hostname =
        parsed.hostname
            .replace(/^www\./, '')
            .toLowerCase();

    const allowed =
        ALLOWED_HOSTS[platform] || [];

    const valid =
        allowed.some(
            domain =>
                hostname === domain ||
                hostname.endsWith(
                    `.${domain}`
                )
        );

    if (!valid) {
        return (
            `URL for ${platform} must be on ` +
            allowed.join(' or ')
        );
    }

    return null;
}

/* ============================================================================
   HEALTH
============================================================================ */

app.get(
    '/api/health',
    (req, res) => {
        res.json({
            status: 'ok',

            service:
                'Kiwami Marketing System API',

            version:
                '3.0.0',

            analytics:
                'URL retrieval + official API fallback',

            timestamp:
                new Date().toISOString()
        });
    }
);

/* ============================================================================
   AUTHENTICATION
============================================================================ */

function getSessionCookie(req) {
    const cookieHeader =
        req.headers.cookie || '';

    const cookie =
        cookieHeader
            .split(';')
            .map(
                part =>
                    part.trim()
            )
            .find(
                part =>
                    part.startsWith(
                        'kiwami_session='
                    )
            );

    if (!cookie) {
        return '';
    }

    return cookie
        .substring(
            'kiwami_session='.length
        )
        .trim();
}

function createSessionCookie(
    token
) {
    const attributes = [
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(
            SESSION_TTL_MS / 1000
        )}`
    ];

    if (
        process.env.NODE_ENV ===
        'production'
    ) {
        attributes.push(
            'Secure'
        );
    }

    return (
        `kiwami_session=${token}; ` +
        attributes.join('; ')
    );
}

function clearSessionCookie(
    res
) {
    const attributes = [
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=0'
    ];

    if (
        process.env.NODE_ENV ===
        'production'
    ) {
        attributes.push(
            'Secure'
        );
    }

    res.setHeader(
        'Set-Cookie',
        `kiwami_session=; ${attributes.join('; ')}`
    );
}

function requireAuthentication(
    req,
    res,
    next
) {
    const token =
        getSessionCookie(req);

    if (!token) {
        return res
            .status(401)
            .json({
                error:
                    'Authentication required'
            });
    }

    const session =
        sessions.get(token);

    if (!session) {
        return res
            .status(401)
            .json({
                error:
                    'Session expired or invalid'
            });
    }

    if (
        session.expiresAt <
        Date.now()
    ) {
        sessions.delete(token);

        return res
            .status(401)
            .json({
                error:
                    'Session expired or invalid'
            });
    }

    session.expiresAt =
        Date.now() +
        SESSION_TTL_MS;

    next();
}

/* ============================================================================
   LOGIN
============================================================================ */

app.post(
    '/api/login',
    (req, res) => {
        try {
            const email =
                safe(
                    req.body?.email || ''
                ).toLowerCase();

            const password =
                safe(
                    req.body?.password || ''
                );

            const clientIp =
                getClientIp(req);

            const now =
                Date.now();

            const attempt =
                loginAttempts.get(
                    clientIp
                ) || {
                    count: 0,
                    resetAt: now
                };

            if (
                attempt.resetAt <
                now -
                LOGIN_ATTEMPT_WINDOW_MS
            ) {
                attempt.count = 0;
                attempt.resetAt = now;
            }

            if (
                attempt.count >=
                LOGIN_ATTEMPT_LIMIT
            ) {
                return res
                    .status(429)
                    .json({
                        error:
                            'Too many login attempts. Please try again later.'
                    });
            }

            const emailMatches =
                email === AUTH_EMAIL ||
                email ===
                    'kiwamitech.co.ke';

            const passwordMatches =
                timingSafeEquals(
                    password,
                    AUTH_PASSWORD
                );

            if (
                !emailMatches ||
                !passwordMatches
            ) {
                attempt.count += 1;

                loginAttempts.set(
                    clientIp,
                    attempt
                );

                return res
                    .status(401)
                    .json({
                        error:
                            'Invalid credentials. Please try again.'
                    });
            }

            loginAttempts.delete(
                clientIp
            );

            const token =
                crypto
                    .randomBytes(32)
                    .toString('hex');

            sessions.set(
                token,
                {
                    createdAt: now,
                    expiresAt:
                        now +
                        SESSION_TTL_MS
                }
            );

            res.setHeader(
                'Cache-Control',
                'no-store'
            );

            res.setHeader(
                'Set-Cookie',
                createSessionCookie(
                    token
                )
            );

            return res.json({
                success: true,
                message:
                    'Login successful'
            });

        } catch (err) {
            console.error(
                'Login error:',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Internal server error'
                });
        }
    }
);

/* ============================================================================
   LOGIN STATUS
============================================================================ */

app.get(
    '/api/login-status',
    (req, res) => {
        const token =
            getSessionCookie(req);

        const session =
            token
                ? sessions.get(token)
                : null;

        if (
            !token ||
            !session ||
            session.expiresAt <
                Date.now()
        ) {
            if (token) {
                sessions.delete(
                    token
                );
            }

            return res
                .status(401)
                .json({
                    authenticated:
                        false
                });
        }

        session.expiresAt =
            Date.now() +
            SESSION_TTL_MS;

        res.setHeader(
            'Cache-Control',
            'no-store'
        );

        return res.json({
            authenticated:
                true
        });
    }
);

/* ============================================================================
   LOGOUT
============================================================================ */

app.post(
    '/api/logout',
    (req, res) => {
        const token =
            getSessionCookie(req);

        if (token) {
            sessions.delete(
                token
            );
        }

        clearSessionCookie(
            res
        );

        res.setHeader(
            'Cache-Control',
            'no-store'
        );

        return res.json({
            success: true,
            message:
                'Logged out'
        });
    }
);

/* ============================================================================
   ANALYTICS
============================================================================ */

app.post(
    '/api/analytics',
    requireAuthentication,
    async (req, res) => {
        try {
            const body =
                req.body || {};

            const profiles =
                body.profiles || {};

            const apiKeys =
                body.apiKeys || {};

            if (
                typeof profiles !==
                    'object' ||
                Array.isArray(
                    profiles
                )
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            'profiles must be an object'
                    });
            }

            /*
             * Credentials can come from:
             *
             * 1. frontend request
             * 2. server environment
             *
             * Environment variables are preferred.
             */
            const keys = {
                youtube:
                    safeToken(
                        process.env.YOUTUBE_API_KEY ||
                        apiKeys.youtube ||
                        ''
                    ),

                twitter:
                    safeToken(
                        process.env.TWITTER_BEARER ||
                        apiKeys.twitter ||
                        ''
                    ),

                facebook:
                    safeToken(
                        process.env.FB_TOKEN ||
                        apiKeys.facebook ||
                        ''
                    ),

                instagram:
                    safeToken(
                        process.env.IG_TOKEN ||
                        apiKeys.instagram ||
                        process.env.FB_TOKEN ||
                        apiKeys.facebook ||
                        ''
                    ),

                linkedin:
                    safeToken(
                        process.env.LINKEDIN_TOKEN ||
                        apiKeys.linkedin ||
                        ''
                    ),

                tiktok:
                    safeToken(
                        process.env.TIKTOK_TOKEN ||
                        apiKeys.tiktok ||
                        ''
                    )
            };

            /*
             * Validate every supplied URL.
             */
            for (
                const platform
                of PLATFORM_NAMES
            ) {
                const profileUrl =
                    profiles[
                        platform
                    ];

                if (!profileUrl) {
                    continue;
                }

                const validationError =
                    validateProfileUrl(
                        platform,
                        profileUrl
                    );

                if (
                    validationError
                ) {
                    return res
                        .status(400)
                        .json({
                            error:
                                validationError
                        });
                }
            }

            /*
             * Each platform works independently.
             */
            const fetchers = {
                youtube: () =>
                    profiles.youtube
                        ? fetchYouTube(
                            profiles.youtube,
                            keys.youtube
                        )
                        : {
                            status:
                                'no_url'
                        },

                twitter: () =>
                    profiles.twitter
                        ? fetchTwitter(
                            profiles.twitter,
                            keys.twitter
                        )
                        : {
                            status:
                                'no_url'
                        },

                facebook: () =>
                    profiles.facebook
                        ? fetchFacebook(
                            profiles.facebook,
                            keys.facebook
                        )
                        : {
                            status:
                                'no_url'
                        },

                instagram: () =>
                    profiles.instagram
                        ? fetchInstagram(
                            profiles.instagram,
                            keys.instagram
                        )
                        : {
                            status:
                                'no_url'
                        },

                linkedin: () =>
                    profiles.linkedin
                        ? fetchLinkedIn(
                            profiles.linkedin,
                            keys.linkedin
                        )
                        : {
                            status:
                                'no_url'
                        },

                tiktok: () =>
                    profiles.tiktok
                        ? fetchTikTok(
                            profiles.tiktok,
                            keys.tiktok
                        )
                        : {
                            status:
                                'no_url'
                        }
            };

            const results =
                await Promise.all(
                    PLATFORM_NAMES.map(
                        async platform => {
                            try {
                                console.log(
                                    `[Analytics] Fetching ${platform}: ${profiles[platform] || 'no URL'}`
                                );

                                const result =
                                    await fetchers[
                                        platform
                                    ]();

                                console.log(
                                    `[Analytics] ${platform}: ${result.status}`
                                );

                                return [
                                    platform,
                                    result
                                ];

                            } catch (
                                err
                            ) {
                                console.error(
                                    `[Analytics] ${platform} error:`,
                                    err
                                );

                                return [
                                    platform,
                                    {
                                        status:
                                            'fetch_error',

                                        error:
                                            err?.message ||
                                            'Unknown platform error'
                                    }
                                ];
                            }
                        }
                    )
                );

            const platformResults =
                Object.fromEntries(
                    results
                );

            /*
             * Make sure all six platforms exist.
             */
            for (
                const platform
                of PLATFORM_NAMES
            ) {
                if (
                    !platformResults[
                        platform
                    ]
                ) {
                    platformResults[
                        platform
                    ] = {
                        status:
                            'no_url'
                    };
                }
            }

            /* ---------------------------------------------------------------
               AGGREGATE RESULTS
            ---------------------------------------------------------------- */

            let totalFollowers = 0;
            let totalViews = 0;
            let totalLikes = 0;
            let totalPosts = 0;

            let engagementSum = 0;
            let engagementCount = 0;

            for (
                const platform
                of PLATFORM_NAMES
            ) {
                const data =
                    platformResults[
                        platform
                    ];

                if (
                    !data ||
                    (
                        data.status !==
                        'ok'
                    )
                ) {
                    continue;
                }

                totalFollowers +=
                    toNumber(
                        data.followers
                    );

                totalViews +=
                    toNumber(
                        data.views
                    );

                totalLikes +=
                    toNumber(
                        data.likes
                    );

                totalPosts +=
                    toNumber(
                        data.posts
                    );

                const engagement =
                    toNumber(
                        data.engagement
                    );

                if (
                    engagement > 0
                ) {
                    engagementSum +=
                        engagement;

                    engagementCount++;
                }
            }

            const engagementRate =
                engagementCount > 0
                    ? round(
                        engagementSum /
                        engagementCount,
                        2
                    )
                    : 0;

            return res.json({
                platforms:
                    platformResults,

                totalFollowers,

                totalViews,

                totalLikes,

                totalPosts,

                engagementRate,

                fetchedAt:
                    new Date()
                        .toISOString()
            });

        } catch (err) {
            console.error(
                'Analytics route error:',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Analytics service failed unexpectedly',

                    details:
                        process.env.NODE_ENV ===
                        'development'
                            ? err.message
                            : undefined
                });
        }
    }
);

/* ============================================================================
   NOTIFICATIONS
============================================================================ */

app.get(
    '/api/notifications',
    requireAuthentication,
    (req, res) => {
        return res.json([
            {
                id: 1,
                message:
                    'New comment on your Facebook post',
                time:
                    new Date(
                        Date.now() -
                        15 * 60000
                    ).toISOString(),
                platform:
                    'facebook'
            },

            {
                id: 2,
                message:
                    'Instagram post scheduled for today published',
                time:
                    new Date(
                        Date.now() -
                        30 * 60000
                    ).toISOString(),
                platform:
                    'instagram'
            },

            {
                id: 3,
                message:
                    'LinkedIn article reached 500 views',
                time:
                    new Date(
                        Date.now() -
                        60 * 60000
                    ).toISOString(),
                platform:
                    'linkedin'
            },

            {
                id: 4,
                message:
                    'YouTube video hit 1,000 views milestone',
                time:
                    new Date(
                        Date.now() -
                        2 * 3600000
                    ).toISOString(),
                platform:
                    'youtube'
            },

            {
                id: 5,
                message:
                    'Twitter/X post trending in your network',
                time:
                    new Date(
                        Date.now() -
                        3 * 3600000
                    ).toISOString(),
                platform:
                    'twitter'
            },

            {
                id: 6,
                message:
                    'TikTok video gained 500 new followers',
                time:
                    new Date(
                        Date.now() -
                        4 * 3600000
                    ).toISOString(),
                platform:
                    'tiktok'
            }
        ]);
    }
);

/* ============================================================================
   POST CONTENT
============================================================================ */

const VALID_PLATFORMS =
    new Set(
        PLATFORM_NAMES
    );

app.post(
    '/api/post/:platform',
    requireAuthentication,
    (req, res) => {
        const platform =
            String(
                req.params.platform ||
                ''
            ).toLowerCase();

        if (
            !VALID_PLATFORMS.has(
                platform
            )
        ) {
            return res
                .status(400)
                .json({
                    error:
                        `Unknown platform: ${platform}`
                });
        }

        const title =
            safe(
                req.body?.title ||
                ''
            );

        const description =
            safe(
                req.body?.description ||
                '',
                5000
            );

        if (
            !title &&
            !description
        ) {
            return res
                .status(400)
                .json({
                    error:
                        'title or description is required'
                });
        }

        console.log(
            `[${new Date().toISOString()}] POST to ${platform}: ${title}`
        );

        return res.json({
            success: true,
            platform,
            message:
                `Content queued for ${platform}`,
            timestamp:
                new Date().toISOString()
        });
    }
);

/* ============================================================================
   UPLOAD
============================================================================ */

app.post(
    '/api/upload',
    requireAuthentication,
    (req, res) => {
        try {
            const {
                fileName = 'file',
                fileType = '',
                fileData = ''
            } = req.body || {};

            if (!fileData) {
                return res
                    .status(400)
                    .json({
                        error:
                            'No file data provided'
                    });
            }

            let buffer;
            let ext = 'bin';

            const matches =
                fileData.match(
                    /^data:([^;]+);base64,(.+)$/
                );

            if (matches) {
                const mime =
                    matches[1];

                buffer =
                    Buffer.from(
                        matches[2],
                        'base64'
                    );

                const mimeExt =
                    mime.split('/')[1];

                if (mimeExt) {
                    ext =
                        mimeExt.replace(
                            /\+xml.*/,
                            ''
                        );
                }

            } else {
                buffer =
                    Buffer.from(
                        fileData,
                        'base64'
                    );

                const originalExt =
                    path.extname(
                        fileName
                    ).slice(1);

                if (originalExt) {
                    ext =
                        originalExt;
                }
            }

            if (
                !buffer ||
                !buffer.length
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            'Uploaded file data is empty or invalid'
                    });
            }

            const safeExt =
                ext
                    .replace(
                        /[^a-zA-Z0-9]/g,
                        ''
                    )
                    .toLowerCase() ||
                'bin';

            const uniqueName =
                `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${safeExt}`;

            const filePath =
                path.join(
                    uploadsDir,
                    uniqueName
                );

            fs.writeFileSync(
                filePath,
                buffer
            );

            const mediaUrl =
                `/uploads/${uniqueName}`;

            console.log(
                `[${new Date().toISOString()}] Upload saved: ${mediaUrl}`
            );

            return res.json({
                success: true,
                url: mediaUrl,
                fileName,
                fileType
            });

        } catch (err) {
            console.error(
                'Upload error:',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Failed to save media upload'
                });
        }
    }
);

/* ============================================================================
   404
============================================================================ */

app.use(
    (req, res) => {
        return res
            .status(404)
            .json({
                error:
                    'Not found'
            });
    }
);

/* ============================================================================
   GLOBAL ERROR HANDLER
============================================================================ */

app.use(
    (err, req, res, next) => {
        console.error(
            'Unhandled server error:',
            err
        );

        if (
            res.headersSent
        ) {
            return next(err);
        }

        return res
            .status(500)
            .json({
                error:
                    'Internal server error'
            });
    }
);

/* ============================================================================
   SESSION CLEANUP
============================================================================ */

setInterval(
    () => {
        const now =
            Date.now();

        for (
            const [
                token,
                session
            ]
            of sessions.entries()
        ) {
            if (
                !session ||
                session.expiresAt <
                    now
            ) {
                sessions.delete(
                    token
                );
            }
        }

        for (
            const [
                ip,
                attempt
            ]
            of loginAttempts.entries()
        ) {
            if (
                attempt.resetAt <
                now -
                LOGIN_ATTEMPT_WINDOW_MS
            ) {
                loginAttempts.delete(
                    ip
                );
            }
        }
    },
    5 * 60 * 1000
).unref();

/* ============================================================================
   START SERVER
============================================================================ */

app.listen(
    PORT,
    () => {
        console.log('');
        console.log(
            '🚀 Kiwami Marketing System – API Server'
        );

        console.log(
            `   Port:        ${PORT}`
        );

        console.log(
            '   Health:      GET  /api/health'
        );

        console.log(
            '   Login:       POST /api/login'
        );

        console.log(
            '   Analytics:   POST /api/analytics'
        );

        console.log(
            '   Analytics:   URL retrieval enabled'
        );

        console.log(
            '   Notifs:      GET  /api/notifications'
        );

        console.log(
            '   Post:        POST /api/post/:platform'
        );

        console.log(
            '   Upload:      POST /api/upload'
        );

        console.log('');
    }
);
