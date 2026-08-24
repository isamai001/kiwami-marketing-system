/**
 * Kiwami Marketing System
 * Backend API Server
 *
 * Drop-in server.js
 *
 * Main fix:
 * - YouTube URLs are resolved to a real channel ID.
 * - YouTube channel statistics are then retrieved directly.
 * - videoCount is returned as "posts".
 * - Existing frontend API contract is preserved.
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

const REQUEST_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 4;

const loginAttempts = new Map();
const sessions = new Map();

const LINKEDIN_VERSION =
    process.env.LINKEDIN_VERSION || '202607';

/* ============================================================================
   UPLOADS
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
        methods: [
            'GET',
            'POST',
            'OPTIONS'
        ],
        allowedHeaders: [
            'Content-Type',
            'Authorization'
        ]
    }));
} else {
    app.use(cors({
        origin: true,
        credentials: true,
        methods: [
            'GET',
            'POST',
            'OPTIONS'
        ],
        allowedHeaders: [
            'Content-Type',
            'Authorization'
        ]
    }));
}

/* ============================================================================
   SECURITY / EXPRESS
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
   HELPERS
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

function safeToken(value, max = 5000) {
    if (typeof value !== 'string') {
        return '';
    }

    return value.trim().slice(0, max);
}

function toNumber(value) {
    const n = Number(value);

    if (!Number.isFinite(n)) {
        return 0;
    }

    return n;
}

function round(value, decimals = 2) {
    const factor = Math.pow(10, decimals);

    return Math.round(
        (toNumber(value) + Number.EPSILON) *
        factor
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
                new Error('Invalid API URL')
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
                Accept: 'application/json',
                'User-Agent':
                    'KiwamiMarketingSystem/3.0',
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
                        [
                            301,
                            302,
                            303,
                            307,
                            308
                        ].includes(
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
                        }
                    );

                    response.on(
                        'end',
                        () => {
                            let body;

                            try {
                                body =
                                    data
                                        ? JSON.parse(data)
                                        : {};
                            } catch {
                                body = data;
                            }

                            resolve({
                                status:
                                    response.statusCode ||
                                    0,

                                headers:
                                    response.headers ||
                                    {},

                                body
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
   AUTHENTICATION
============================================================================ */

function getSessionCookie(req) {
    const cookieHeader =
        req.headers.cookie || '';

    const cookie =
        cookieHeader
            .split(';')
            .map(
                part => part.trim()
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

function createSessionCookie(token) {
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
        attributes.push('Secure');
    }

    return (
        `kiwami_session=${token}; ` +
        attributes.join('; ')
    );
}

function clearSessionCookie(res) {
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
        attributes.push('Secure');
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
   YOUTUBE URL PARSING
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
            hostname !==
                'youtube.com' &&
            hostname !==
                'm.youtube.com' &&
            hostname !==
                'youtu.be'
        ) {
            return null;
        }

        const pathname =
            u.pathname
                .replace(/\/+$/, '');

        /*
         * /channel/UCxxxx
         */
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

        /*
         * /@username
         */
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

        /*
         * /user/username
         */
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

        /*
         * /c/username
         */
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

        /*
         * Bare channel/custom URL.
         */
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

/* ============================================================================
   YOUTUBE CHANNEL ID RESOLUTION
============================================================================ */

/*
 * This is the important YouTube fix.
 *
 * No matter whether the user gives:
 *
 * https://youtube.com/channel/UC...
 * https://youtube.com/@username
 * https://youtube.com/c/name
 * https://youtube.com/user/name
 *
 * we resolve it to the actual YouTube channel ID first.
 */

async function resolveYouTubeChannelId(
    profileUrl,
    apiKey
) {
    const parsed =
        parseYouTube(profileUrl);

    if (!parsed) {
        return {
            error:
                'Cannot parse YouTube channel URL'
        };
    }

    /*
     * Direct channel ID.
     *
     * This is the most reliable route.
     */
    if (
        parsed.type === 'id'
    ) {
        return {
            channelId:
                parsed.value
        };
    }

    /*
     * Handle.
     *
     * YouTube Data API supports forHandle.
     */
    if (
        parsed.type === 'handle'
    ) {
        const params =
            new URLSearchParams();

        params.set(
            'part',
            'id'
        );

        params.set(
            'forHandle',
            parsed.value
        );

        params.set(
            'maxResults',
            '1'
        );

        params.set(
            'key',
            apiKey
        );

        const response =
            await apiGet(
                `https://www.googleapis.com/youtube/v3/channels?${params.toString()}`
            );

        if (
            response.status === 200 &&
            response.body?.items?.[0]?.id
        ) {
            return {
                channelId:
                    response.body.items[0].id
            };
        }

        /*
         * Some API configurations may not resolve the handle
         * through forHandle. Fall back to search.
         */
    }

    /*
     * Legacy username.
     */
    if (
        parsed.type ===
        'forUsername'
    ) {
        const params =
            new URLSearchParams();

        params.set(
            'part',
            'id'
        );

        params.set(
            'forUsername',
            parsed.value
        );

        params.set(
            'maxResults',
            '1'
        );

        params.set(
            'key',
            apiKey
        );

        const response =
            await apiGet(
                `https://www.googleapis.com/youtube/v3/channels?${params.toString()}`
            );

        if (
            response.status === 200 &&
            response.body?.items?.[0]?.id
        ) {
            return {
                channelId:
                    response.body.items[0].id
            };
        }
    }

    /*
     * Search fallback.
     *
     * Used for /c/name and bare URLs.
     */
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
        '10'
    );

    searchParams.set(
        'q',
        parsed.value
    );

    searchParams.set(
        'key',
        apiKey
    );

    const searchResponse =
        await apiGet(
            `https://www.googleapis.com/youtube/v3/search?${searchParams.toString()}`
        );

    if (
        searchResponse.status !== 200
    ) {
        return {
            error:
                jsonErrorMessage(
                    searchResponse.body,
                    `YouTube search failed (HTTP ${searchResponse.status})`
                )
        };
    }

    const items =
        searchResponse.body?.items ||
        [];

    if (!items.length) {
        return {
            error:
                'YouTube channel could not be found from the supplied URL.'
        };
    }

    /*
     * Prefer exact channel-title matches where possible.
     */
    const requested =
        String(
            parsed.value || ''
        )
            .toLowerCase()
            .replace(/^@/, '');

    let selected =
        items.find(
            item =>
                String(
                    item.snippet?.title ||
                    ''
                )
                    .toLowerCase()
                    .replace(/\s+/g, '') ===
                requested.replace(
                    /\s+/g,
                    ''
                )
        );

    if (!selected) {
        selected = items[0];
    }

    const channelId =
        selected?.snippet?.channelId ||
        selected?.id?.channelId;

    if (!channelId) {
        return {
            error:
                'YouTube search found a result but no channel ID was returned.'
        };
    }

    return {
        channelId
    };
}

/* ============================================================================
   YOUTUBE
============================================================================ */

async function fetchYouTube(
    profileUrl,
    apiKey
) {
    if (!apiKey) {
        return {
            status:
                'no_credentials',

            error:
                'YouTube API Key not set',

            setup:
                'Add your YouTube Data API v3 key in the frontend or YOUTUBE_API_KEY environment variable.'
        };
    }

    /*
     * STEP 1:
     * Resolve the supplied URL to the actual channel ID.
     */
    const resolved =
        await resolveYouTubeChannelId(
            profileUrl,
            apiKey
        );

    if (
        !resolved.channelId
    ) {
        return {
            status:
                'not_found',

            error:
                resolved.error ||
                'Could not resolve YouTube channel ID.'
        };
    }

    const channelId =
        resolved.channelId;

    /*
     * STEP 2:
     * Get channel statistics directly by ID.
     *
     * videoCount is returned by YouTube here.
     */
    const params =
        new URLSearchParams();

    params.set(
        'part',
        'snippet,statistics,contentDetails'
    );

    params.set(
        'id',
        channelId
    );

    params.set(
        'key',
        apiKey
    );

    const response =
        await apiGet(
            `https://www.googleapis.com/youtube/v3/channels?${params.toString()}`
        );

    if (
        response.status !== 200
    ) {
        return {
            status:
                'api_error',

            error:
                jsonErrorMessage(
                    response.body,
                    `YouTube API returned HTTP ${response.status}`
                )
        };
    }

    const item =
        response.body?.items?.[0];

    if (!item) {
        return {
            status:
                'not_found',

            error:
                'YouTube channel was resolved but channel statistics could not be retrieved.'
        };
    }

    const statistics =
        item.statistics || {};

    /*
     * These are the actual public YouTube channel statistics.
     */
    const subscribers =
        toNumber(
            statistics.subscriberCount
        );

    const views =
        toNumber(
            statistics.viewCount
        );

    const videos =
        toNumber(
            statistics.videoCount
        );

    /*
     * YouTube channels.list does not provide a lifetime
     * channel-level likes total.
     *
     * Therefore we intentionally keep this as 0.
     */
    const likes = 0;

    /*
     * This is not a true YouTube Analytics engagement rate.
     * We preserve the existing frontend field.
     */
    let engagement = 0;

    if (
        subscribers > 0 &&
        views > 0
    ) {
        engagement =
            round(
                (
                    views /
                    subscribers
                ) * 100,
                2
            );
    }

    /*
     * Helpful server-side diagnostic.
     *
     * If videoCount is still 0, this will make it obvious in
     * the backend logs what YouTube actually returned.
     */
    console.log(
        `[YouTube] ${item.snippet?.title || channelId} | subscribers=${subscribers} | views=${views} | videoCount=${videos}`
    );

    return {
        status:
            'ok',

        name:
            item.snippet?.title ||
            'YouTube Channel',

        channelId,

        followers:
            subscribers,

        views,

        likes,

        /*
         * IMPORTANT:
         * Existing frontend expects "posts".
         *
         * YouTube videoCount is mapped to posts here.
         */
        posts:
            videos,

        engagement
    };
}

/* ============================================================================
   TWITTER / X
============================================================================ */

function parseTwitterUsername(
    rawUrl
) {
    try {
        const u =
            new URL(rawUrl);

        const pathname =
            u.pathname
                .replace(
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

async function fetchTwitter(
    profileUrl,
    bearerToken
) {
    if (!bearerToken) {
        return {
            status:
                'no_credentials',

            error:
                'Twitter/X Bearer Token not set'
        };
    }

    const username =
        parseTwitterUsername(
            profileUrl
        );

    if (!username) {
        return {
            status:
                'invalid_url',

            error:
                'Cannot parse Twitter/X profile URL'
        };
    }

    const fields =
        'public_metrics,name,description,username';

    const endpoint =
        `https://api.twitter.com/2/users/by/username/${encodeURIComponent(username)}` +
        `?user.fields=${encodeURIComponent(fields)}`;

    const response =
        await apiGet(
            endpoint,
            {
                Authorization:
                    `Bearer ${bearerToken}`
            }
        );

    if (
        response.status === 401
    ) {
        return {
            status:
                'api_error',

            error:
                'Invalid or expired Twitter/X Bearer Token'
        };
    }

    if (
        response.status === 404
    ) {
        return {
            status:
                'not_found',

            error:
                `Twitter/X user @${username} was not found`
        };
    }

    if (
        response.status !== 200
    ) {
        return {
            status:
                'api_error',

            error:
                jsonErrorMessage(
                    response.body,
                    `Twitter/X API returned HTTP ${response.status}`
                )
        };
    }

    const data =
        response.body?.data;

    const metrics =
        data?.public_metrics;

    if (
        !data ||
        !metrics
    ) {
        return {
            status:
                'api_error',

            error:
                'Twitter/X returned an unexpected response'
        };
    }

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
        status:
            'ok',

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

/* ============================================================================
   FACEBOOK
============================================================================ */

function parseFacebookId(
    rawUrl
) {
    try {
        const u =
            new URL(rawUrl);

        const id =
            u.searchParams.get(
                'id'
            );

        if (id) {
            return id;
        }

        const pathname =
            u.pathname
                .replace(
                    /^\/+|\/+$/g,
                    ''
                );

        if (!pathname) {
            return null;
        }

        const first =
            pathname.split('/')[0];

        if (
            [
                'pages',
                'groups',
                'events',
                'watch',
                'login',
                'share',
                'sharer',
                'reel'
            ].includes(
                first.toLowerCase()
            )
        ) {
            return null;
        }

        return first;

    } catch {
        return null;
    }
}

async function fetchFacebook(
    profileUrl,
    accessToken
) {
    if (!accessToken) {
        return {
            status:
                'no_credentials',

            error:
                'Facebook Page Access Token not set'
        };
    }

    const pageId =
        parseFacebookId(
            profileUrl
        );

    if (!pageId) {
        return {
            status:
                'invalid_url',

            error:
                'Cannot parse Facebook Page URL'
        };
    }

    const fields =
        [
            'id',
            'name',
            'followers_count',
            'fan_count'
        ].join(',');

    const pageUrl =
        `https://graph.facebook.com/v23.0/${encodeURIComponent(pageId)}` +
        `?fields=${encodeURIComponent(fields)}` +
        `&access_token=${encodeURIComponent(accessToken)}`;

    const pageResponse =
        await apiGet(
            pageUrl
        );

    if (
        pageResponse.status !== 200
    ) {
        return {
            status:
                'api_error',

            error:
                jsonErrorMessage(
                    pageResponse.body,
                    `Facebook Graph API returned HTTP ${pageResponse.status}`
                )
        };
    }

    const page =
        pageResponse.body ||
        {};

    const followers =
        toNumber(
            page.followers_count ||
            page.fan_count
        );

    const postsFields =
        'id,message,created_time,likes.limit(0).summary(true),comments.limit(0).summary(true)';

    const postsUrl =
        `https://graph.facebook.com/v23.0/${encodeURIComponent(page.id || pageId)}/posts` +
        `?fields=${encodeURIComponent(postsFields)}` +
        `&limit=25` +
        `&access_token=${encodeURIComponent(accessToken)}`;

    const postsResponse =
        await apiGet(
            postsUrl
        );

    let posts = 0;
    let likes = 0;
    let comments = 0;

    if (
        postsResponse.status === 200
    ) {
        const data =
            postsResponse.body?.data ||
            [];

        posts =
            data.length;

        for (
            const post of data
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
        likes +
        comments;

    const engagement =
        posts > 0 &&
        followers > 0
            ? round(
                (
                    interactions /
                    posts /
                    followers
                ) * 100,
                2
            )
            : 0;

    return {
        status:
            'ok',

        name:
            page.name ||
            'Facebook Page',

        followers,

        views: 0,

        likes,

        posts,

        engagement
    };
}

/* ============================================================================
   INSTAGRAM
============================================================================ */

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
                'direct'
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

async function fetchInstagram(
    profileUrl,
    accessToken
) {
    if (!accessToken) {
        return {
            status:
                'no_credentials',

            error:
                'Instagram / Meta Access Token not set'
        };
    }

    const username =
        parseInstagramUsername(
            profileUrl
        );

    if (!username) {
        return {
            status:
                'invalid_url',

            error:
                'Cannot parse Instagram profile URL'
        };
    }

    const pagesUrl =
        `https://graph.facebook.com/v23.0/me/accounts` +
        `?fields=id,name,access_token` +
        `&limit=100` +
        `&access_token=${encodeURIComponent(accessToken)}`;

    const pagesResponse =
        await apiGet(
            pagesUrl
        );

    if (
        pagesResponse.status !== 200
    ) {
        return {
            status:
                'api_error',

            error:
                jsonErrorMessage(
                    pagesResponse.body,
                    `Meta API returned HTTP ${pagesResponse.status}`
                )
        };
    }

    const pages =
        pagesResponse.body?.data ||
        [];

    if (!pages.length) {
        return {
            status:
                'api_error',

            error:
                'No Facebook Pages are available to this access token.'
        };
    }

    for (
        const page of pages
    ) {
        const pageToken =
            page.access_token ||
            accessToken;

        const relationshipUrl =
            `https://graph.facebook.com/v23.0/${encodeURIComponent(page.id)}` +
            `?fields=instagram_business_account` +
            `&access_token=${encodeURIComponent(pageToken)}`;

        const relationshipResponse =
            await apiGet(
                relationshipUrl
            );

        if (
            relationshipResponse.status !== 200
        ) {
            continue;
        }

        const igId =
            relationshipResponse
                .body
                ?.instagram_business_account
                ?.id;

        if (!igId) {
            continue;
        }

        const statsFields =
            [
                'id',
                'username',
                'name',
                'followers_count',
                'media_count'
            ].join(',');

        const statsUrl =
            `https://graph.facebook.com/v23.0/${encodeURIComponent(igId)}` +
            `?fields=${encodeURIComponent(statsFields)}` +
            `&access_token=${encodeURIComponent(pageToken)}`;

        const statsResponse =
            await apiGet(
                statsUrl
            );

        if (
            statsResponse.status !== 200
        ) {
            continue;
        }

        const stats =
            statsResponse.body ||
            {};

        if (
            stats.username &&
            username &&
            stats.username.toLowerCase() !==
                username.toLowerCase()
        ) {
            continue;
        }

        const followers =
            toNumber(
                stats.followers_count
            );

        const mediaCount =
            toNumber(
                stats.media_count
            );

        let likes = 0;
        let comments = 0;
        let mediaReturned = 0;

        const mediaFields =
            'id,like_count,comments_count,timestamp';

        const mediaUrl =
            `https://graph.facebook.com/v23.0/${encodeURIComponent(igId)}/media` +
            `?fields=${encodeURIComponent(mediaFields)}` +
            `&limit=25` +
            `&access_token=${encodeURIComponent(pageToken)}`;

        const mediaResponse =
            await apiGet(
                mediaUrl
            );

        if (
            mediaResponse.status === 200
        ) {
            const media =
                mediaResponse.body?.data ||
                [];

            mediaReturned =
                media.length;

            for (
                const item of media
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
            likes +
            comments;

        const engagement =
            mediaReturned > 0 &&
            followers > 0
                ? round(
                    (
                        interactions /
                        mediaReturned /
                        followers
                    ) * 100,
                    2
                )
                : 0;

        return {
            status:
                'ok',

            name:
                stats.name ||
                stats.username ||
                'Instagram',

            followers,

            views: 0,

            likes,

            posts:
                mediaCount,

            engagement
        };
    }

    return {
        status:
            'api_error',

        error:
            `Could not find Instagram professional account @${username}.`
    };
}

/* ============================================================================
   LINKEDIN
============================================================================ */

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

async function fetchLinkedIn(
    profileUrl,
    accessToken
) {
    if (!accessToken) {
        return {
            status:
                'no_credentials',

            error:
                'LinkedIn Access Token not set'
        };
    }

    const orgVanity =
        parseLinkedInOrg(
            profileUrl
        );

    if (!orgVanity) {
        return {
            status:
                'invalid_url',

            error:
                'Cannot parse LinkedIn company URL'
        };
    }

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

    const orgUrl =
        `https://api.linkedin.com/rest/organizations` +
        `?q=vanityName` +
        `&vanityName=${encodeURIComponent(orgVanity)}`;

    const orgResponse =
        await apiGet(
            orgUrl,
            headers
        );

    if (
        orgResponse.status !== 200
    ) {
        return {
            status:
                'api_error',

            error:
                jsonErrorMessage(
                    orgResponse.body,
                    `LinkedIn organization lookup returned HTTP ${orgResponse.status}`
                )
        };
    }

    const org =
        orgResponse.body
            ?.elements?.[0];

    const orgId =
        org?.id;

    if (!orgId) {
        return {
            status:
                'not_found',

            error:
                'LinkedIn organisation not found'
        };
    }

    let followers = 0;

    const followerUrl =
        `https://api.linkedin.com/v2/networkSizes/urn%3Ali%3Aorganization%3A${encodeURIComponent(orgId)}` +
        `?edgeType=CompanyFollowedByMember`;

    const followerResponse =
        await apiGet(
            followerUrl,
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

    const organizationUrn =
        `urn:li:organization:${orgId}`;

    const statsUrl =
        `https://api.linkedin.com/rest/organizationalEntityShareStatistics` +
        `?q=organizationalEntity` +
        `&organizationalEntity=${encodeURIComponent(organizationUrn)}`;

    const statsResponse =
        await apiGet(
            statsUrl,
            headers
        );

    let views = 0;
    let likes = 0;
    let comments = 0;
    let shares = 0;
    let posts = 0;

    if (
        statsResponse.status === 200
    ) {
        const elements =
            statsResponse.body?.elements ||
            [];

        posts =
            elements.length;

        for (
            const element of elements
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

    const engagement =
        views > 0
            ? round(
                (
                    interactions /
                    views
                ) * 100,
                2
            )
            : 0;

    return {
        status:
            'ok',

        name:
            org?.localizedName ||
            org?.vanityName ||
            orgVanity,

        followers,

        views,

        likes,

        posts,

        engagement
    };
}

/* ============================================================================
   TIKTOK
============================================================================ */

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

async function fetchTikTok(
    profileUrl,
    accessToken
) {
    if (!accessToken) {
        return {
            status:
                'no_credentials',

            error:
                'TikTok user access token not set'
        };
    }

    const username =
        parseTikTokUsername(
            profileUrl
        );

    if (!username) {
        return {
            status:
                'invalid_url',

            error:
                'Cannot parse TikTok URL'
        };
    }

    const fields =
        [
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
        response.status === 401
    ) {
        return {
            status:
                'api_error',

            error:
                'TikTok access token is invalid or expired'
        };
    }

    if (
        response.status !== 200
    ) {
        return {
            status:
                'api_error',

            error:
                jsonErrorMessage(
                    response.body,
                    `TikTok API returned HTTP ${response.status}`
                )
        };
    }

    const user =
        response.body
            ?.data?.user;

    if (!user) {
        return {
            status:
                'api_error',

            error:
                'TikTok returned no user data.'
        };
    }

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
        status:
            'ok',

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

/* ============================================================================
   PLATFORM CONFIG
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
        return (
            `Invalid URL for ${platform}`
        );
    }

    if (
        ![
            'http:',
            'https:'
        ].includes(
            parsed.protocol
        )
    ) {
        return (
            `Invalid protocol for ${platform}`
        );
    }

    const hostname =
        parsed.hostname
            .replace(/^www\./, '')
            .toLowerCase();

    const allowed =
        ALLOWED_HOSTS[platform] ||
        [];

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
            status:
                'ok',

            service:
                'Kiwami Marketing System API',

            version:
                '3.0.0',

            timestamp:
                new Date().toISOString()
        });
    }
);

/* ============================================================================
   LOGIN
============================================================================ */

app.post(
    '/api/login',
    (req, res) => {
        try {
            const email =
                safe(
                    req.body?.email ||
                    ''
                ).toLowerCase();

            const password =
                safe(
                    req.body?.password ||
                    ''
                );

            const clientIp =
                getClientIp(req);

            const now =
                Date.now();

            const currentAttempt =
                loginAttempts.get(
                    clientIp
                ) || {
                    count: 0,
                    resetAt: now
                };

            if (
                currentAttempt.resetAt <
                now -
                LOGIN_ATTEMPT_WINDOW_MS
            ) {
                currentAttempt.count = 0;

                currentAttempt.resetAt =
                    now;
            }

            if (
                currentAttempt.count >=
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
                currentAttempt.count += 1;

                loginAttempts.set(
                    clientIp,
                    currentAttempt
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
                    createdAt:
                        now,

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
                success:
                    true,

                message:
                    'Login successful'
            });

        } catch (err) {
            console.error(
                'Login handler error:',
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
            success:
                true,

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

            const keys = {
                youtube:
                    safeToken(
                        apiKeys.youtube ||
                        process.env.YOUTUBE_API_KEY ||
                        ''
                    ),

                twitter:
                    safeToken(
                        apiKeys.twitter ||
                        process.env.TWITTER_BEARER ||
                        ''
                    ),

                facebook:
                    safeToken(
                        apiKeys.facebook ||
                        process.env.FB_TOKEN ||
                        ''
                    ),

                instagram:
                    safeToken(
                        apiKeys.instagram ||
                        process.env.IG_TOKEN ||
                        apiKeys.facebook ||
                        process.env.FB_TOKEN ||
                        ''
                    ),

                linkedin:
                    safeToken(
                        apiKeys.linkedin ||
                        process.env.LINKEDIN_TOKEN ||
                        ''
                    ),

                tiktok:
                    safeToken(
                        apiKeys.tiktok ||
                        process.env.TIKTOK_TOKEN ||
                        ''
                    )
            };

            for (
                const platform of
                PLATFORM_NAMES
            ) {
                const rawUrl =
                    profiles[platform];

                if (!rawUrl) {
                    continue;
                }

                const validationError =
                    validateProfileUrl(
                        platform,
                        rawUrl
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

            const fetchers = {
                youtube:
                    () =>
                        profiles.youtube
                            ? fetchYouTube(
                                profiles.youtube,
                                keys.youtube
                            )
                            : {
                                status:
                                    'no_url'
                            },

                twitter:
                    () =>
                        profiles.twitter
                            ? fetchTwitter(
                                profiles.twitter,
                                keys.twitter
                            )
                            : {
                                status:
                                    'no_url'
                            },

                facebook:
                    () =>
                        profiles.facebook
                            ? fetchFacebook(
                                profiles.facebook,
                                keys.facebook
                            )
                            : {
                                status:
                                    'no_url'
                            },

                instagram:
                    () =>
                        profiles.instagram
                            ? fetchInstagram(
                                profiles.instagram,
                                keys.instagram
                            )
                            : {
                                status:
                                    'no_url'
                            },

                linkedin:
                    () =>
                        profiles.linkedin
                            ? fetchLinkedIn(
                                profiles.linkedin,
                                keys.linkedin
                            )
                            : {
                                status:
                                    'no_url'
                            },

                tiktok:
                    () =>
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
                                return [
                                    platform,

                                    await fetchers[
                                        platform
                                    ]()
                                ];
                            } catch (
                                error
                            ) {
                                console.error(
                                    `${platform} analytics error:`,
                                    error
                                );

                                return [
                                    platform,
                                    {
                                        status:
                                            'fetch_error',

                                        error:
                                            error?.message ||
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

            for (
                const platform of
                PLATFORM_NAMES
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

            let totalFollowers = 0;
            let totalViews = 0;
            let totalLikes = 0;
            let totalPosts = 0;

            let engagementSum = 0;
            let engagementCount = 0;

            for (
                const platform of
                PLATFORM_NAMES
            ) {
                const data =
                    platformResults[
                        platform
                    ];

                if (
                    data?.status !==
                    'ok'
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

                if (
                    Number.isFinite(
                        Number(
                            data.engagement
                        )
                    )
                ) {
                    engagementSum +=
                        toNumber(
                            data.engagement
                        );

                    engagementCount += 1;
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
                    new Date().toISOString()
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
        res.json([
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
            success:
                true,

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
                `[${new Date().toISOString()}] Upload saved: ${mediaUrl} (${buffer.length} bytes)`
            );

            return res.json({
                success:
                    true,

                url:
                    mediaUrl,

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
        res
            .status(404)
            .json({
                error:
                    'Not found'
            });
    }
);

/* ============================================================================
   ERROR HANDLER
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

        res
            .status(500)
            .json({
                error:
                    'Internal server error'
            });
    }
);

/* ============================================================================
   CLEANUP
============================================================================ */

setInterval(
    () => {
        const now =
            Date.now();

        for (
            const [
                token,
                session
            ] of sessions.entries()
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
            ] of loginAttempts.entries()
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
   START
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
            '   YouTube:     Channel ID + statistics.videoCount'
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
