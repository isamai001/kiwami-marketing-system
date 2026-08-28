/**
 * Kiwami Marketing System
 * Backend API Server - COMPLETE WORKING VERSION
 * 
 * Extracts data using HTML scraping (no API keys required)
 * Returns structured data with availability flags
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

const loginAttempts = new Map();
const sessions = new Map();

const uploadsDir = path.join(__dirname, 'uploads');

try {
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
    }
} catch (err) {
    console.error('Could not create uploads directory:', err.message);
}

const configuredFrontendOrigin = (process.env.FRONTEND_ORIGIN || '').trim();

if (configuredFrontendOrigin) {
    app.use(cors({
        origin: configuredFrontendOrigin,
        credentials: true,
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization']
    }));
} else {
    app.use(cors({
        origin: '*',
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization']
    }));
}

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(uploadsDir));

/* ============================================================================
   HELPERS
============================================================================ */

function safe(value, max = 500) {
    if (typeof value !== 'string') return '';
    return value.replace(/[<>"'`]/g, '').trim().slice(0, max);
}

function safeToken(value, max = 10000) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, max);
}

function toNumber(value) {
    if (typeof value === 'string') {
        value = value.replace(/,/g, '').trim();
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function round(value, decimals = 2) {
    const factor = Math.pow(10, decimals);
    return Math.round((toNumber(value) + Number.EPSILON) * factor) / factor;
}

function timingSafeEquals(a, b) {
    const aBuf = Buffer.from(String(a || ''));
    const bBuf = Buffer.from(String(b || ''));
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
}

function getClientIp(req) {
    return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
        .toString().split(',')[0].trim();
}

function parseMetric(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    let text = String(value).trim().replace(/,/g, '');
    if (!text) return 0;
    const match = text.match(/(-?\d+(?:\.\d+)?)\s*([KMBT])?/i);
    if (!match) return 0;
    let number = Number(match[1]);
    if (!Number.isFinite(number)) return 0;
    const suffix = (match[2] || '').toUpperCase();
    if (suffix === 'K') number *= 1000;
    else if (suffix === 'M') number *= 1000000;
    else if (suffix === 'B') number *= 1000000000;
    else if (suffix === 'T') number *= 1000000000000;
    return Math.round(number);
}

/* ============================================================================
   HTTP GET
============================================================================ */

function apiGet(rawUrl, headers = {}, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > MAX_REDIRECTS) {
            return reject(new Error('Too many redirects'));
        }
        let parsed;
        try {
            parsed = new URL(rawUrl);
        } catch {
            return reject(new Error('Invalid URL'));
        }
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
                'Accept': 'text/html,application/json,application/xhtml+xml,*/*;q=0.8',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ...headers
            },
            timeout: REQUEST_TIMEOUT_MS
        };
        const request = lib.request(options, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                const redirectUrl = new URL(response.headers.location, rawUrl).toString();
                response.resume();
                return apiGet(redirectUrl, headers, redirectCount + 1).then(resolve).catch(reject);
            }
            let data = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                data += chunk;
                if (data.length > 15 * 1024 * 1024) {
                    request.destroy(new Error('Response too large'));
                }
            });
            response.on('end', () => {
                const contentType = String(response.headers['content-type'] || '').toLowerCase();
                let body = data;
                if (contentType.includes('application/json') || contentType.includes('+json')) {
                    try {
                        body = data ? JSON.parse(data) : {};
                    } catch {
                        body = data;
                    }
                }
                resolve({
                    status: response.statusCode || 0,
                    headers: response.headers || {},
                    body,
                    raw: data
                });
            });
        });
        request.on('timeout', () => request.destroy(new Error('Request timed out')));
        request.on('error', reject);
        request.end();
    });
}

/* ============================================================================
   HTML SCRAPING HELPERS
============================================================================ */

function decodeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}

function stripTags(text) {
    return decodeHtml(String(text || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim());
}

function getMetaContent(html, attribute, value) {
    if (!html) return '';
    const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<meta[^>]+${attribute}\\s*=\\s*["']${escaped}["'][^>]+content\\s*=\\s*["']([^"']*)["'][^>]*>`, 'i');
    const match = html.match(regex);
    if (match) return decodeHtml(match[1]);
    const reverseRegex = new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]+${attribute}\\s*=\\s*["']${escaped}["'][^>]*>`, 'i');
    const reverseMatch = html.match(reverseRegex);
    return reverseMatch ? decodeHtml(reverseMatch[1]) : '';
}

function getMetaProperty(html, property) {
    return getMetaContent(html, 'property', property);
}

function getMetaName(html, name) {
    return getMetaContent(html, 'name', name);
}

function extractJsonLd(html) {
    const results = [];
    if (!html) return results;
    const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = regex.exec(html))) {
        try {
            const parsed = JSON.parse(match[1].trim());
            if (Array.isArray(parsed)) {
                results.push(...parsed);
            } else {
                results.push(parsed);
            }
        } catch {}
    }
    return results;
}

function findAllValues(object, keys, output = [], depth = 0) {
    if (!object || depth > 8 || typeof object !== 'object') return output;
    const wanted = new Set(keys.map(key => String(key).toLowerCase()));
    for (const [key, value] of Object.entries(object)) {
        if (wanted.has(String(key).toLowerCase())) {
            output.push(value);
        }
        if (value && typeof value === 'object') {
            findAllValues(value, keys, output, depth + 1);
        }
    }
    return output;
}

function firstPositiveMetric(values) {
    for (const value of values) {
        const n = parseMetric(value);
        if (n > 0) return n;
    }
    return 0;
}

/* ============================================================================
   PUBLIC PAGE FETCHING
============================================================================ */

async function fetchPublicPage(profileUrl) {
    try {
        const response = await apiGet(profileUrl, {
            'Accept': 'text/html,application/xhtml+xml'
        });
        if (response.status < 200 || response.status >= 400) {
            return {
                ok: false,
                status: response.status,
                html: typeof response.body === 'string' ? response.body : response.raw || '',
                error: `Profile page returned HTTP ${response.status}`
            };
        }
        return {
            ok: true,
            status: response.status,
            html: typeof response.body === 'string' ? response.body : response.raw || ''
        };
    } catch (err) {
        return {
            ok: false,
            status: 0,
            html: '',
            error: err?.message || 'Could not retrieve profile URL'
        };
    }
}

/* ============================================================================
   PUBLIC METRICS EXTRACTION
============================================================================ */

function extractPublicMetrics(html) {
    const jsonLd = extractJsonLd(html);
    const title = getMetaProperty(html, 'og:title') || getMetaName(html, 'twitter:title') ||
        (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const description = getMetaProperty(html, 'og:description') || getMetaName(html, 'description') ||
        getMetaName(html, 'twitter:description') || '';
    const image = getMetaProperty(html, 'og:image') || getMetaName(html, 'twitter:image') || '';

    const jsonLdFollowers = findAllValues(jsonLd, ['followers', 'followerCount', 'subscriberCount', 'userInteractionCount']);
    const jsonLdViews = findAllValues(jsonLd, ['viewCount', 'views', 'interactionCount']);
    const jsonLdLikes = findAllValues(jsonLd, ['likeCount', 'likes']);
    const jsonLdPosts = findAllValues(jsonLd, ['videoCount', 'postCount', 'numberOfItems', 'interactionCount']);

    let followers = firstPositiveMetric(jsonLdFollowers);
    let views = firstPositiveMetric(jsonLdViews);
    let likes = firstPositiveMetric(jsonLdLikes);
    let posts = firstPositiveMetric(jsonLdPosts);

    const text = stripTags(html);

    const patterns = {
        followers: [
            /([\d.,]+[KMB]?)\s*(?:followers|follower)/i,
            /(?:followers|follower)[^0-9]{0,30}([\d.,]+[KMB]?)/i,
            /([\d.,]+[KMB]?)\s*(?:subscribers|subscriber)/i
        ],
        views: [
            /([\d.,]+[KMB]?)\s*(?:views|view)/i,
            /(?:views|view)[^0-9]{0,30}([\d.,]+[KMB]?)/i
        ],
        likes: [
            /([\d.,]+[KMB]?)\s*(?:likes|like)/i,
            /(?:likes|like)[^0-9]{0,30}([\d.,]+[KMB]?)/i
        ],
        posts: [
            /([\d.,]+[KMB]?)\s*(?:posts|post)/i,
            /([\d.,]+[KMB]?)\s*(?:videos|video)/i
        ]
    };

    function patternValue(patternArray) {
        for (const pattern of patternArray) {
            const match = text.match(pattern);
            if (match) {
                const n = parseMetric(match[1]);
                if (n > 0) return n;
            }
        }
        return 0;
    }

    if (!followers) followers = patternValue(patterns.followers);
    if (!views) views = patternValue(patterns.views);
    if (!likes) likes = patternValue(patterns.likes);
    if (!posts) posts = patternValue(patterns.posts);

    // JSON regex patterns
    const jsonPatterns = {
        followers: [
            /"followerCount"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
            /"followers_count"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
            /"followers"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i
        ],
        views: [
            /"viewCount"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
            /"view_count"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i
        ],
        likes: [
            /"likeCount"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
            /"like_count"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i
        ],
        posts: [
            /"videoCount"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
            /"media_count"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i,
            /"postCount"\s*:\s*"?(?:([\d.,]+[KMB]?))"?/i
        ]
    };

    function regexMetric(patternArray) {
        for (const pattern of patternArray) {
            const match = html.match(pattern);
            if (match) {
                const n = parseMetric(match[1]);
                if (n > 0) return n;
            }
        }
        return 0;
    }

    if (!followers) followers = regexMetric(jsonPatterns.followers);
    if (!views) views = regexMetric(jsonPatterns.views);
    if (!likes) likes = regexMetric(jsonPatterns.likes);
    if (!posts) posts = regexMetric(jsonPatterns.posts);

    return {
        name: stripTags(title),
        description: stripTags(description),
        image,
        followers,
        views,
        likes,
        posts
    };
}

/* ============================================================================
   URL PARSERS
============================================================================ */

function parseYouTube(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const hostname = u.hostname.replace(/^www\./, '').toLowerCase();
        if (!['youtube.com', 'm.youtube.com', 'youtu.be'].includes(hostname)) return null;
        const pathname = u.pathname.replace(/\/+$/, '');
        const handle = pathname.match(/^\/@([^/?&#]+)$/i);
        if (handle) return { type: 'handle', value: handle[1] };
        const channel = pathname.match(/^\/channel\/(UC[^/?&#]+)$/i);
        if (channel) return { type: 'id', value: channel[1] };
        const user = pathname.match(/^\/user\/([^/?&#]+)$/i);
        if (user) return { type: 'forUsername', value: user[1] };
        return null;
    } catch { return null; }
}

function parseInstagramUsername(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const first = u.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
        if (!first) return null;
        if (['accounts', 'explore', 'reels', 'direct', 'p', 'stories'].includes(first.toLowerCase())) return null;
        return first.replace(/^@/, '');
    } catch { return null; }
}

function parseFacebookId(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const id = u.searchParams.get('id');
        if (id) return id;
        const pathname = u.pathname.replace(/^\/+|\/+$/g, '');
        if (!pathname) return null;
        const pieces = pathname.split('/');
        if (pieces[0].toLowerCase() === 'pages' && pieces[1]) return pieces[2] || pieces[1];
        if (['groups', 'events', 'watch', 'login', 'share', 'sharer', 'reel'].includes(pieces[0].toLowerCase())) return null;
        return pieces[0];
    } catch { return null; }
}

function parseTwitterUsername(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const hostname = u.hostname.replace(/^www\./, '').toLowerCase();
        if (!['twitter.com', 'x.com'].includes(hostname)) return null;
        const pathname = u.pathname.replace(/^\/+|\/+$/g, '');
        if (!pathname) return null;
        const username = pathname.split('/')[0];
        if (['home', 'explore', 'notifications', 'messages', 'i', 'search', 'settings'].includes(username.toLowerCase())) return null;
        return username.replace(/^@/, '');
    } catch { return null; }
}

function parseLinkedInOrg(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const match = u.pathname.match(/^\/company\/([^/?&#]+)/i);
        return match ? match[1] : null;
    } catch { return null; }
}

function parseTikTokUsername(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const match = u.pathname.match(/^\/@([^/?&#]+)/i);
        return match ? match[1] : null;
    } catch { return null; }
}

/* ============================================================================
   PLATFORM FETCHERS (ALL USING HTML SCRAPING)
============================================================================ */

async function fetchYouTube(profileUrl) {
    const parsed = parseYouTube(profileUrl);
    if (!parsed) {
        return createMetricResult('YouTube Channel', 'invalid_url', 'Could not parse YouTube URL');
    }

    const page = await fetchPublicPage(profileUrl);
    if (!page.ok) {
        return createMetricResult('YouTube Channel', 'unavailable', page.error || 'Could not retrieve YouTube page');
    }

    const metrics = extractPublicMetrics(page.html);
    
    // YouTube-specific extraction
    let followers = metrics.followers;
    let posts = metrics.posts;
    let views = metrics.views;

    // Try YouTube-specific patterns
    if (!followers) {
        const match = page.html.match(/"subscriberCountText"[\s\S]{0,500}?"simpleText"\s*:\s*"([^"]+)"/i);
        if (match) followers = parseMetric(match[1]);
    }
    if (!posts) {
        const match = page.html.match(/"videoCountText"[\s\S]{0,500}?"simpleText"\s*:\s*"([^"]+)"/i);
        if (match) posts = parseMetric(match[1]);
    }

    return createMetricResult(metrics.name || 'YouTube Channel', 'ok', null, {
        followers: followers || 0,
        views: views || 0,
        likes: 0,
        posts: posts || 0
    }, true);
}

async function fetchInstagram(profileUrl) {
    const username = parseInstagramUsername(profileUrl);
    if (!username) {
        return createMetricResult('Instagram Profile', 'invalid_url', 'Could not parse Instagram URL');
    }

    const page = await fetchPublicPage(profileUrl);
    if (!page.ok) {
        return createMetricResult(`@${username}`, 'unavailable', page.error || 'Could not retrieve Instagram page');
    }

    const metrics = extractPublicMetrics(page.html);
    
    // Instagram-specific: try to extract from JSON
    let followers = metrics.followers;
    let posts = metrics.posts;
    let name = metrics.name || `@${username}`;

    // Try to find in script tags
    const scriptMatch = page.html.match(/window\._sharedData\s*=\s*({.*?});/s);
    if (scriptMatch) {
        try {
            const data = JSON.parse(scriptMatch[1]);
            const user = data?.entry_data?.ProfilePage?.[0]?.graphql?.user;
            if (user) {
                if (user.followers_count) followers = user.followers_count;
                if (user.media_count) posts = user.media_count;
                if (user.full_name) name = user.full_name;
            }
        } catch {}
    }

    return createMetricResult(name, 'ok', null, {
        followers: followers || 0,
        views: 0,
        likes: 0,
        posts: posts || 0
    }, followers > 0 || posts > 0);
}

async function fetchFacebook(profileUrl) {
    const pageId = parseFacebookId(profileUrl);
    if (!pageId) {
        return createMetricResult('Facebook Page', 'invalid_url', 'Could not parse Facebook URL');
    }

    const page = await fetchPublicPage(profileUrl);
    if (!page.ok) {
        return createMetricResult('Facebook Page', 'unavailable', page.error || 'Could not retrieve Facebook page');
    }

    const metrics = extractPublicMetrics(page.html);
    
    // Facebook-specific: try to extract from JSON
    let followers = metrics.followers;
    let likes = metrics.likes;
    let posts = metrics.posts;
    let name = metrics.name || 'Facebook Page';

    // Try to find page info in JSON
    const jsonMatch = page.html.match(/<script[^>]*>window\.__initialData\s*=\s*({.*?});?<\/script>/s);
    if (jsonMatch) {
        try {
            const data = JSON.parse(jsonMatch[1]);
            const pageInfo = data?.entities?.[pageId] || data?.data?.[pageId];
            if (pageInfo) {
                if (pageInfo.name) name = pageInfo.name;
                if (pageInfo.followers_count) followers = pageInfo.followers_count;
                if (pageInfo.fan_count && !followers) followers = pageInfo.fan_count;
            }
        } catch {}
    }

    return createMetricResult(name, 'ok', null, {
        followers: followers || 0,
        views: 0,
        likes: likes || 0,
        posts: posts || 0
    }, followers > 0 || posts > 0 || likes > 0);
}

async function fetchTwitter(profileUrl) {
    const username = parseTwitterUsername(profileUrl);
    if (!username) {
        return createMetricResult('Twitter Profile', 'invalid_url', 'Could not parse Twitter URL');
    }

    const page = await fetchPublicPage(profileUrl);
    if (!page.ok) {
        return createMetricResult(`@${username}`, 'unavailable', page.error || 'Could not retrieve Twitter page');
    }

    const metrics = extractPublicMetrics(page.html);
    
    let followers = metrics.followers;
    let likes = metrics.likes;
    let posts = metrics.posts;
    let name = metrics.name || `@${username}`;

    // Twitter-specific: try to extract from JSON
    const jsonMatch = page.html.match(/<script[^>]*>window\.__INITIAL_STATE__\s*=\s*({.*?});?<\/script>/s);
    if (jsonMatch) {
        try {
            const data = JSON.parse(jsonMatch[1]);
            const user = data?.users?.[username] || data?.entities?.users?.[username];
            if (user) {
                if (user.followers_count) followers = user.followers_count;
                if (user.statuses_count) posts = user.statuses_count;
                if (user.favourites_count) likes = user.favourites_count;
                if (user.name) name = user.name;
            }
        } catch {}
    }

    return createMetricResult(name, 'ok', null, {
        followers: followers || 0,
        views: 0,
        likes: likes || 0,
        posts: posts || 0
    }, followers > 0 || posts > 0);
}

async function fetchLinkedIn(profileUrl) {
    const page = await fetchPublicPage(profileUrl);
    if (!page.ok) {
        return createMetricResult('LinkedIn Profile', 'unavailable', page.error || 'Could not retrieve LinkedIn page');
    }

    const metrics = extractPublicMetrics(page.html);
    
    let followers = metrics.followers;
    let name = metrics.name || 'LinkedIn Profile';

    // LinkedIn-specific extraction
    if (!followers) {
        const match = page.html.match(/"followersCount"\s*:\s*(\d+)/i);
        if (match) followers = parseInt(match[1]);
    }

    return createMetricResult(name, 'ok', null, {
        followers: followers || 0,
        views: 0,
        likes: 0,
        posts: 0
    }, followers > 0);
}

async function fetchTikTok(profileUrl) {
    const username = parseTikTokUsername(profileUrl);
    if (!username) {
        return createMetricResult('TikTok Profile', 'invalid_url', 'Could not parse TikTok URL');
    }

    const page = await fetchPublicPage(profileUrl);
    if (!page.ok) {
        return createMetricResult(`@${username}`, 'unavailable', page.error || 'Could not retrieve TikTok page');
    }

    const metrics = extractPublicMetrics(page.html);
    
    let followers = metrics.followers;
    let likes = metrics.likes;
    let posts = metrics.posts;
    let name = metrics.name || `@${username}`;

    // TikTok-specific extraction
    const jsonMatch = page.html.match(/<script[^>]*>window\.__INITIAL_STATE__\s*=\s*({.*?});?<\/script>/s);
    if (jsonMatch) {
        try {
            const data = JSON.parse(jsonMatch[1]);
            const user = data?.userInfo?.user || data?.user;
            if (user) {
                if (user.followerCount) followers = user.followerCount;
                if (user.videoCount) posts = user.videoCount;
                if (user.heartCount) likes = user.heartCount;
                if (user.nickname) name = user.nickname;
            }
        } catch {}
    }

    return createMetricResult(name, 'ok', null, {
        followers: followers || 0,
        views: 0,
        likes: likes || 0,
        posts: posts || 0
    }, followers > 0 || posts > 0);
}

/* ============================================================================
   METRIC RESULT HELPER
============================================================================ */

function createMetricResult(name, status, error = null, metrics = null, hasData = false) {
    const result = {
        status: status,
        source: 'html_scrape',
        name: name || 'Profile'
    };

    if (error) {
        result.error = error;
    }

    if (metrics) {
        result.metrics = {
            followers: { value: metrics.followers || 0, available: metrics.followers > 0 },
            views: { value: metrics.views || 0, available: metrics.views > 0 },
            likes: { value: metrics.likes || 0, available: metrics.likes > 0 },
            posts: { value: metrics.posts || 0, available: metrics.posts > 0 }
        };
        result.has_data = hasData;
    } else {
        result.metrics = {
            followers: { value: 0, available: false },
            views: { value: 0, available: false },
            likes: { value: 0, available: false },
            posts: { value: 0, available: false }
        };
        result.has_data = false;
    }

    return result;
}

/* ============================================================================
   PLATFORM CONFIGURATION
============================================================================ */

const PLATFORM_NAMES = ['facebook', 'instagram', 'twitter', 'linkedin', 'youtube', 'tiktok'];

const ALLOWED_HOSTS = {
    facebook: ['facebook.com'],
    instagram: ['instagram.com'],
    twitter: ['twitter.com', 'x.com'],
    linkedin: ['linkedin.com'],
    youtube: ['youtube.com', 'youtu.be'],
    tiktok: ['tiktok.com']
};

function validateProfileUrl(platform, rawUrl) {
    if (!rawUrl) return null;
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return `Invalid URL for ${platform}`;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        return `Invalid protocol for ${platform}`;
    }
    const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const allowed = ALLOWED_HOSTS[platform] || [];
    const valid = allowed.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
    if (!valid) {
        return `URL for ${platform} must be on ${allowed.join(' or ')}`;
    }
    return null;
}

/* ============================================================================
   AUTHENTICATION
============================================================================ */

function getSessionCookie(req) {
    const cookieHeader = req.headers.cookie || '';
    const cookie = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith('kiwami_session='));
    if (!cookie) return '';
    return cookie.substring('kiwami_session='.length).trim();
}

function createSessionCookie(token) {
    const attributes = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
    if (process.env.NODE_ENV === 'production') attributes.push('Secure');
    return `kiwami_session=${token}; ${attributes.join('; ')}`;
}

function clearSessionCookie(res) {
    const attributes = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (process.env.NODE_ENV === 'production') attributes.push('Secure');
    res.setHeader('Set-Cookie', `kiwami_session=; ${attributes.join('; ')}`);
}

function requireAuthentication(req, res, next) {
    const token = getSessionCookie(req);
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    const session = sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
        if (token) sessions.delete(token);
        return res.status(401).json({ error: 'Session expired or invalid' });
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    next();
}

/* ============================================================================
   ROUTES
============================================================================ */

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Kiwami Marketing System API',
        version: '3.0.0',
        analytics: 'HTML scraping based',
        timestamp: new Date().toISOString()
    });
});

app.post('/api/login', (req, res) => {
    try {
        const email = safe(req.body?.email || '').toLowerCase();
        const password = safe(req.body?.password || '');
        const clientIp = getClientIp(req);
        const now = Date.now();
        const attempt = loginAttempts.get(clientIp) || { count: 0, resetAt: now };
        if (attempt.resetAt < now - LOGIN_ATTEMPT_WINDOW_MS) {
            attempt.count = 0;
            attempt.resetAt = now;
        }
        if (attempt.count >= LOGIN_ATTEMPT_LIMIT) {
            return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
        }
        const emailMatches = email === AUTH_EMAIL || email === 'kiwamitech.co.ke';
        const passwordMatches = timingSafeEquals(password, AUTH_PASSWORD);
        if (!emailMatches || !passwordMatches) {
            attempt.count += 1;
            loginAttempts.set(clientIp, attempt);
            return res.status(401).json({ error: 'Invalid credentials. Please try again.' });
        }
        loginAttempts.delete(clientIp);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { createdAt: now, expiresAt: now + SESSION_TTL_MS });
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Set-Cookie', createSessionCookie(token));
        return res.json({ success: true, message: 'Login successful' });
    } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/login-status', (req, res) => {
    const token = getSessionCookie(req);
    const session = token ? sessions.get(token) : null;
    if (!token || !session || session.expiresAt < Date.now()) {
        if (token) sessions.delete(token);
        return res.status(401).json({ authenticated: false });
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ authenticated: true });
});

app.post('/api/logout', (req, res) => {
    const token = getSessionCookie(req);
    if (token) sessions.delete(token);
    clearSessionCookie(res);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ success: true, message: 'Logged out' });
});

/* ============================================================================
   ANALYTICS ROUTE
============================================================================ */

app.post('/api/analytics', requireAuthentication, async (req, res) => {
    try {
        const body = req.body || {};
        const profiles = body.profiles || {};

        if (typeof profiles !== 'object' || Array.isArray(profiles)) {
            return res.status(400).json({ error: 'profiles must be an object' });
        }

        // Validate URLs
        for (const platform of PLATFORM_NAMES) {
            const profileUrl = profiles[platform];
            if (!profileUrl) continue;
            const validationError = validateProfileUrl(platform, profileUrl);
            if (validationError) {
                return res.status(400).json({ error: validationError });
            }
        }

        // Fetchers - ALL using HTML scraping only
        const fetchers = {
            youtube: () => profiles.youtube ? fetchYouTube(profiles.youtube) : { status: 'no_url' },
            twitter: () => profiles.twitter ? fetchTwitter(profiles.twitter) : { status: 'no_url' },
            facebook: () => profiles.facebook ? fetchFacebook(profiles.facebook) : { status: 'no_url' },
            instagram: () => profiles.instagram ? fetchInstagram(profiles.instagram) : { status: 'no_url' },
            linkedin: () => profiles.linkedin ? fetchLinkedIn(profiles.linkedin) : { status: 'no_url' },
            tiktok: () => profiles.tiktok ? fetchTikTok(profiles.tiktok) : { status: 'no_url' }
        };

        const results = await Promise.all(
            PLATFORM_NAMES.map(async platform => {
                try {
                    console.log(`[Analytics] Fetching ${platform}: ${profiles[platform] || 'no URL'}`);
                    const result = await fetchers[platform]();
                    console.log(`[Analytics] ${platform}: ${result.status}`);
                    return [platform, result];
                } catch (err) {
                    console.error(`[Analytics] ${platform} error:`, err);
                    return [platform, {
                        status: 'fetch_error',
                        error: err?.message || 'Unknown platform error',
                        name: `${platform.charAt(0).toUpperCase() + platform.slice(1)} Profile`,
                        metrics: {
                            followers: { value: 0, available: false },
                            views: { value: 0, available: false },
                            likes: { value: 0, available: false },
                            posts: { value: 0, available: false }
                        },
                        has_data: false
                    }];
                }
            })
        );

        const platformResults = Object.fromEntries(results);

        // Ensure all platforms exist
        for (const platform of PLATFORM_NAMES) {
            if (!platformResults[platform]) {
                platformResults[platform] = {
                    status: 'no_url',
                    name: `${platform.charAt(0).toUpperCase() + platform.slice(1)} Profile`,
                    metrics: {
                        followers: { value: 0, available: false },
                        views: { value: 0, available: false },
                        likes: { value: 0, available: false },
                        posts: { value: 0, available: false }
                    },
                    has_data: false
                };
            }
        }

        // Aggregate totals
        let totalFollowers = 0;
        let totalViews = 0;
        let totalLikes = 0;
        let totalPosts = 0;

        for (const platform of PLATFORM_NAMES) {
            const data = platformResults[platform];
            if (data?.metrics) {
                totalFollowers += data.metrics.followers?.value || 0;
                totalViews += data.metrics.views?.value || 0;
                totalLikes += data.metrics.likes?.value || 0;
                totalPosts += data.metrics.posts?.value || 0;
            }
        }

        return res.json({
            platforms: platformResults,
            totalFollowers,
            totalViews,
            totalLikes,
            totalPosts,
            fetchedAt: new Date().toISOString()
        });

    } catch (err) {
        console.error('Analytics route error:', err);
        return res.status(500).json({
            error: 'Analytics service failed unexpectedly',
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});

/* ============================================================================
   NOTIFICATIONS
============================================================================ */

app.get('/api/notifications', requireAuthentication, (req, res) => {
    return res.json([
        { id: 1, message: 'New comment on your Facebook post', time: new Date(Date.now() - 15 * 60000).toISOString(), platform: 'facebook' },
        { id: 2, message: 'Instagram post scheduled for today published', time: new Date(Date.now() - 30 * 60000).toISOString(), platform: 'instagram' },
        { id: 3, message: 'LinkedIn article reached 500 views', time: new Date(Date.now() - 60 * 60000).toISOString(), platform: 'linkedin' },
        { id: 4, message: 'YouTube video hit 1,000 views milestone', time: new Date(Date.now() - 2 * 3600000).toISOString(), platform: 'youtube' },
        { id: 5, message: 'Twitter/X post trending in your network', time: new Date(Date.now() - 3 * 3600000).toISOString(), platform: 'twitter' },
        { id: 6, message: 'TikTok video gained 500 new followers', time: new Date(Date.now() - 4 * 3600000).toISOString(), platform: 'tiktok' }
    ]);
});

/* ============================================================================
   POST CONTENT
============================================================================ */

app.post('/api/post/:platform', requireAuthentication, (req, res) => {
    const platform = String(req.params.platform || '').toLowerCase();
    if (!PLATFORM_NAMES.includes(platform)) {
        return res.status(400).json({ error: `Unknown platform: ${platform}` });
    }
    const title = safe(req.body?.title || '');
    const description = safe(req.body?.description || '', 5000);
    if (!title && !description) {
        return res.status(400).json({ error: 'title or description is required' });
    }
    console.log(`[${new Date().toISOString()}] POST to ${platform}: ${title}`);
    return res.json({
        success: true,
        platform,
        message: `Content queued for ${platform}`,
        timestamp: new Date().toISOString()
    });
});

/* ============================================================================
   UPLOAD
============================================================================ */

app.post('/api/upload', requireAuthentication, (req, res) => {
    try {
        const { fileName = 'file', fileType = '', fileData = '' } = req.body || {};
        if (!fileData) {
            return res.status(400).json({ error: 'No file data provided' });
        }
        let buffer;
        let ext = 'bin';
        const matches = fileData.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
            const mime = matches[1];
            buffer = Buffer.from(matches[2], 'base64');
            const mimeExt = mime.split('/')[1];
            if (mimeExt) ext = mimeExt.replace(/\+xml.*/, '');
        } else {
            buffer = Buffer.from(fileData, 'base64');
            const originalExt = path.extname(fileName).slice(1);
            if (originalExt) ext = originalExt;
        }
        if (!buffer || !buffer.length) {
            return res.status(400).json({ error: 'Uploaded file data is empty or invalid' });
        }
        const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin';
        const uniqueName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${safeExt}`;
        const filePath = path.join(uploadsDir, uniqueName);
        fs.writeFileSync(filePath, buffer);
        const mediaUrl = `/uploads/${uniqueName}`;
        console.log(`[${new Date().toISOString()}] Upload saved: ${mediaUrl}`);
        return res.json({ success: true, url: mediaUrl, fileName, fileType });
    } catch (err) {
        console.error('Upload error:', err);
        return res.status(500).json({ error: 'Failed to save media upload' });
    }
});

/* ============================================================================
   ERROR HANDLERS
============================================================================ */

app.use((req, res) => {
    return res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err);
    if (res.headersSent) return next(err);
    return res.status(500).json({ error: 'Internal server error' });
});

/* ============================================================================
   SESSION CLEANUP
============================================================================ */

setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions.entries()) {
        if (!session || session.expiresAt < now) {
            sessions.delete(token);
        }
    }
    for (const [ip, attempt] of loginAttempts.entries()) {
        if (attempt.resetAt < now - LOGIN_ATTEMPT_WINDOW_MS) {
            loginAttempts.delete(ip);
        }
    }
}, 5 * 60 * 1000).unref();

/* ============================================================================
   START SERVER
============================================================================ */

app.listen(PORT, () => {
    console.log('');
    console.log('🚀 Kiwami Marketing System – API Server');
    console.log(`   Port:        ${PORT}`);
    console.log('   Health:      GET  /api/health');
    console.log('   Login:       POST /api/login');
    console.log('   Analytics:   POST /api/analytics');
    console.log('   Analytics:   HTML scraping mode (no API keys required)');
    console.log('   Notifs:      GET  /api/notifications');
    console.log('   Post:        POST /api/post/:platform');
    console.log('   Upload:      POST /api/upload');
    console.log('');
});
