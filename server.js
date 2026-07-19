/**
 * Kiwami Marketing System – Backend API Server
 * Performs REAL API calls to social media platforms.
 * API keys are supplied per-request from the frontend (stored in browser localStorage).
 * Environment variables serve as server-side fallbacks.
 */

require('dotenv').config();
const https  = require('https');
const http   = require('http');
const url    = require('url');
const express = require('express');
const cors   = require('cors');
const path   = require('path');

const app = express();

// ── Security ──────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; " +
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
        "font-src 'self' https://cdnjs.cloudflare.com; img-src 'self' data: blob:;"
    );
    next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

// ── Low-level HTTPS/HTTP GET helper ──────────────────────────────────────────
function apiGet(rawUrl, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsed  = new url.URL(rawUrl);
        const isHttps = parsed.protocol === 'https:';
        const lib     = isHttps ? https : http;

        const options = {
            hostname : parsed.hostname,
            port     : parsed.port || (isHttps ? 443 : 80),
            path     : parsed.pathname + parsed.search,
            method   : 'GET',
            headers  : { Accept: 'application/json', 'User-Agent': 'KiwamiMarketingSystem/1.0', ...headers },
            timeout  : 12000
        };

        const req = lib.request(options, res => {
            // Follow redirects (up to 3)
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                return apiGet(res.headers.location, headers).then(resolve).catch(reject);
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let body;
                try { body = JSON.parse(data); } catch { body = data; }
                resolve({ status: res.statusCode, body });
            });
        });

        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.on('error', reject);
        req.end();
    });
}

// ── Sanitise helpers ──────────────────────────────────────────────────────────
function safe(str, max = 500) {
    if (typeof str !== 'string') return '';
    return str.replace(/[<>"'`]/g, '').trim().slice(0, max);
}

// ── URL parsers ───────────────────────────────────────────────────────────────
function parseYouTube(rawUrl) {
    try {
        const u = new url.URL(rawUrl);
        const path = u.pathname;

        // @handle  →  youtube.com/@channelname
        const handle = path.match(/^\/@([^/?&#]+)/);
        if (handle) return { type: 'handle', value: handle[1] };

        // channel/UCxxxxx
        const channel = path.match(/^\/channel\/(UC[^/?&#]+)/);
        if (channel) return { type: 'id', value: channel[1] };

        // /c/name  or  /user/name  (legacy)
        const custom = path.match(/^\/(?:c|user)\/([^/?&#]+)/);
        if (custom) return { type: 'forUsername', value: custom[1] };

        // bare youtube.com/name  (some channels)
        const bare = path.match(/^\/([^/?&#]+)/);
        if (bare && !['watch', 'playlist', 'shorts', 'feed', 'results'].includes(bare[1])) {
            return { type: 'forUsername', value: bare[1] };
        }
    } catch { /* fall through */ }
    return null;
}

function parseTwitterUsername(rawUrl) {
    try {
        const m = new url.URL(rawUrl).pathname.match(/^\/([^/?&#]+)/);
        if (m && !['home', 'explore', 'notifications', 'messages', 'i', 'search'].includes(m[1])) {
            return m[1].replace(/^@/, '');
        }
    } catch { /* fall through */ }
    return null;
}

function parseFacebookId(rawUrl) {
    try {
        const u  = new url.URL(rawUrl);
        // profile.php?id=xxxxxxx
        const id = u.searchParams.get('id');
        if (id) return id;
        // /pagename
        const m = u.pathname.match(/^\/([^/?&#]+)/);
        if (m && !['pages', 'groups', 'events', 'watch', 'login'].includes(m[1])) return m[1];
    } catch { /* fall through */ }
    return null;
}

function parseInstagramUsername(rawUrl) {
    try {
        const m = new url.URL(rawUrl).pathname.match(/^\/([^/?&#]+)/);
        return m ? m[1].replace(/^@/, '') : null;
    } catch { return null; }
}

function parseLinkedInOrg(rawUrl) {
    try {
        const m = new url.URL(rawUrl).pathname.match(/^\/company\/([^/?&#]+)/);
        return m ? m[1] : null;
    } catch { return null; }
}

function parseTikTokUsername(rawUrl) {
    try {
        const m = new url.URL(rawUrl).pathname.match(/^\/@([^/?&#]+)/);
        return m ? m[1] : null;
    } catch { return null; }
}

// ── Platform fetchers ─────────────────────────────────────────────────────────

/**
 * YOUTUBE DATA API v3
 * Docs: https://developers.google.com/youtube/v3/docs/channels/list
 * Key : Google Cloud Console → YouTube Data API v3
 */
async function fetchYouTube(profileUrl, apiKey) {
    if (!apiKey) return { status: 'no_credentials', error: 'YouTube API Key not set', setup: 'Get a free key from console.cloud.google.com → YouTube Data API v3' };
    const parsed = parseYouTube(profileUrl);
    if (!parsed) return { status: 'invalid_url', error: 'Cannot parse YouTube URL' };

    let qp = `part=statistics,snippet&key=${encodeURIComponent(apiKey)}`;
    if      (parsed.type === 'handle')      qp += `&forHandle=${encodeURIComponent(parsed.value)}`;
    else if (parsed.type === 'id')          qp += `&id=${encodeURIComponent(parsed.value)}`;
    else if (parsed.type === 'forUsername') qp += `&forUsername=${encodeURIComponent(parsed.value)}`;

    const res = await apiGet(`https://www.googleapis.com/youtube/v3/channels?${qp}`);
    if (res.status !== 200) return { status: 'api_error', error: res.body?.error?.message || `HTTP ${res.status}` };

    const item = res.body?.items?.[0];
    if (!item) return { status: 'not_found', error: 'Channel not found. Check the URL.' };

    const s     = item.statistics;
    const subs  = parseInt(s.subscriberCount  || 0);
    const views = parseInt(s.viewCount        || 0);
    const vids  = parseInt(s.videoCount       || 0);

    return {
        status      : 'ok',
        name        : item.snippet?.title,
        followers   : subs,
        views       : views,
        likes       : 0,  // YouTube hides public like totals
        posts       : vids,
        engagement  : subs > 0 && vids > 0 ? parseFloat(((views / subs / vids) * 100).toFixed(2)) : 0
    };
}

/**
 * TWITTER / X API v2
 * Docs: https://developer.twitter.com/en/docs/twitter-api/users/lookup/api-reference
 * Key : developer.twitter.com → Bearer Token (Free plan supports user lookup)
 */
async function fetchTwitter(profileUrl, bearerToken) {
    if (!bearerToken) return { status: 'no_credentials', error: 'Twitter Bearer Token not set', setup: 'Get a Bearer Token from developer.twitter.com → Projects & Apps' };
    const username = parseTwitterUsername(profileUrl);
    if (!username) return { status: 'invalid_url', error: 'Cannot parse Twitter/X username' };

    const res = await apiGet(
        `https://api.twitter.com/2/users/by/username/${encodeURIComponent(username)}?user.fields=public_metrics,name,description`,
        { Authorization: `Bearer ${bearerToken}` }
    );
    if (res.status === 401) return { status: 'api_error', error: 'Invalid Bearer Token' };
    if (res.status === 404) return { status: 'not_found', error: `User @${username} not found` };
    if (res.status !== 200) return { status: 'api_error', error: res.body?.detail || res.body?.errors?.[0]?.message || `HTTP ${res.status}` };

    const pm = res.body?.data?.public_metrics;
    if (!pm) return { status: 'api_error', error: 'Unexpected API response' };

    const followers = pm.followers_count;
    const likes     = pm.like_count || 0;
    return {
        status      : 'ok',
        name        : res.body.data.name,
        followers   : followers,
        views       : 0,   // impression_count requires Elevated access
        likes       : likes,
        posts       : pm.tweet_count || 0,
        engagement  : followers > 0 ? parseFloat(((likes / followers) * 100).toFixed(2)) : 0
    };
}

/**
 * FACEBOOK GRAPH API
 * Docs: https://developers.facebook.com/docs/graph-api
 * Key : developers.facebook.com → Graph API Explorer → generate Page Access Token
 */
async function fetchFacebook(profileUrl, accessToken) {
    if (!accessToken) return { status: 'no_credentials', error: 'Facebook Access Token not set', setup: 'Generate a Page Access Token in developers.facebook.com → Graph API Explorer' };
    const pageId = parseFacebookId(profileUrl);
    if (!pageId) return { status: 'invalid_url', error: 'Cannot parse Facebook page URL' };

    const fields = 'name,followers_count,fan_count,posts.limit(10){likes.summary(true),comments.summary(true)}';
    const res = await apiGet(`https://graph.facebook.com/v19.0/${encodeURIComponent(pageId)}?fields=${fields}&access_token=${encodeURIComponent(accessToken)}`);

    if (res.status !== 200) return { status: 'api_error', error: res.body?.error?.message || `HTTP ${res.status}` };

    const d         = res.body;
    const followers = d.followers_count || d.fan_count || 0;

    let totalReactions = 0;
    let totalComments  = 0;
    const postCount    = d.posts?.data?.length || 0;
    (d.posts?.data || []).forEach(p => {
        totalReactions += p.likes?.summary?.total_count    || 0;
        totalComments  += p.comments?.summary?.total_count || 0;
    });

    const engRate = postCount > 0 && followers > 0
        ? parseFloat((((totalReactions + totalComments) / postCount / followers) * 100).toFixed(2))
        : 0;

    return {
        status      : 'ok',
        name        : d.name,
        followers   : followers,
        views       : 0,
        likes       : totalReactions,
        posts       : postCount,
        engagement  : engRate
    };
}

/**
 * INSTAGRAM GRAPH API (via Facebook / Meta)
 * Docs: https://developers.facebook.com/docs/instagram-api
 * Key : Same Facebook Page Access Token – account must be an Instagram Business account connected to a Facebook Page
 */
async function fetchInstagram(profileUrl, accessToken) {
    if (!accessToken) return { status: 'no_credentials', error: 'Instagram Access Token not set', setup: 'Use the same Facebook Page Access Token. Your Instagram must be a Business account connected to a Facebook Page.' };

    // Step 1: Get the Facebook Pages for this token
    const pagesRes = await apiGet(`https://graph.facebook.com/v19.0/me/accounts?access_token=${encodeURIComponent(accessToken)}`);
    if (pagesRes.status !== 200) return { status: 'api_error', error: pagesRes.body?.error?.message || `HTTP ${pagesRes.status}` };

    const pages = pagesRes.body?.data || [];
    if (!pages.length) return { status: 'api_error', error: 'No Facebook Pages found linked to this token' };

    // Step 2: Find the page that has an Instagram Business Account
    for (const page of pages) {
        const pageRes = await apiGet(`https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${encodeURIComponent(accessToken)}`);
        const igId    = pageRes.body?.instagram_business_account?.id;
        if (!igId) continue;

        // Step 3: Fetch Instagram stats
        const statsRes = await apiGet(`https://graph.facebook.com/v19.0/${igId}?fields=username,name,followers_count,media_count,profile_views&access_token=${encodeURIComponent(accessToken)}`);
        if (statsRes.status !== 200) continue;

        const s = statsRes.body;
        return {
            status     : 'ok',
            name       : s.name || s.username,
            followers  : s.followers_count || 0,
            views      : s.profile_views   || 0,
            likes      : 0,
            posts      : s.media_count     || 0,
            engagement : 0  // Requires Insights API (business accounts with 100+ followers)
        };
    }
    return { status: 'api_error', error: 'No Instagram Business Account found linked to your Facebook token' };
}

/**
 * LINKEDIN API v2
 * Docs: https://learn.microsoft.com/en-us/linkedin/marketing/
 * Key : developers.linkedin.com → OAuth 2.0 Access Token with r_organization_social scope
 */
async function fetchLinkedIn(profileUrl, accessToken) {
    if (!accessToken) return { status: 'no_credentials', error: 'LinkedIn Access Token not set', setup: 'Create a LinkedIn App at developers.linkedin.com and get an OAuth 2.0 access token with r_organization_social scope' };
    const orgVanity = parseLinkedInOrg(profileUrl);
    if (!orgVanity) return { status: 'invalid_url', error: 'Cannot parse LinkedIn company URL (expected /company/...)' };

    const headers = { Authorization: `Bearer ${accessToken}`, 'X-Restli-Protocol-Version': '2.0.0' };

    // Step 1: resolve org by vanityName
    const orgRes = await apiGet(`https://api.linkedin.com/v2/organizations?q=vanityName&vanityName=${encodeURIComponent(orgVanity)}`, headers);
    if (orgRes.status !== 200) return { status: 'api_error', error: orgRes.body?.message || `HTTP ${orgRes.status}` };

    const orgId = orgRes.body?.elements?.[0]?.id;
    if (!orgId) return { status: 'not_found', error: 'LinkedIn organisation not found' };

    // Step 2: follower count
    const fRes = await apiGet(`https://api.linkedin.com/v2/networkSizes/urn:li:organization:${orgId}?edgeType=CompanyFollowedByMember`, headers);
    const followers = fRes.body?.firstDegreeSize || 0;

    // Step 3: page stats (impressions/clicks, optional)
    const statsRes = await apiGet(
        `https://api.linkedin.com/v2/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=urn:li:organization:${orgId}&timeIntervals.timeGranularityType=MONTH&timeIntervals.timeRange.start=1&timeIntervals.timeRange.end=9999999999999`,
        headers
    );
    const impressions = statsRes.body?.elements?.reduce((acc, el) => acc + (el.totalShareStatistics?.impressionCount || 0), 0) || 0;
    const likes       = statsRes.body?.elements?.reduce((acc, el) => acc + (el.totalShareStatistics?.likeCount       || 0), 0) || 0;

    return {
        status     : 'ok',
        followers  : followers,
        views      : impressions,
        likes      : likes,
        posts      : 0,
        engagement : followers > 0 && likes > 0 ? parseFloat(((likes / followers) * 100).toFixed(2)) : 0
    };
}

/**
 * TIKTOK FOR DEVELOPERS API
 * Docs: https://developers.tiktok.com/doc/tiktok-api-v2-user-info
 * Key : developers.tiktok.com → Client Access Token (requires approved app + Sandbox or Production access)
 */
async function fetchTikTok(profileUrl, clientToken) {
    if (!clientToken) return { status: 'no_credentials', error: 'TikTok Client Token not set', setup: 'Apply for TikTok API access at developers.tiktok.com. Requires app approval. Use the Client Access Token.' };
    const username = parseTikTokUsername(profileUrl);
    if (!username) return { status: 'invalid_url', error: 'Cannot parse TikTok username (expected tiktok.com/@username)' };

    const res = await apiGet(
        'https://open.tiktokapis.com/v2/user/info/?fields=follower_count,following_count,video_count,likes_count,display_name',
        { Authorization: `Bearer ${clientToken}` }
    );

    if (res.status === 401) return { status: 'api_error', error: 'Invalid TikTok Client Token' };
    if (res.status !== 200) return { status: 'api_error', error: res.body?.error?.message || `HTTP ${res.status}` };

    const u = res.body?.data?.user;
    if (!u) return { status: 'api_error', error: 'Unexpected TikTok API response' };

    const followers = u.follower_count || 0;
    const likes     = u.likes_count    || 0;
    return {
        status     : 'ok',
        name       : u.display_name,
        followers  : followers,
        views      : 0,
        likes      : likes,
        posts      : u.video_count || 0,
        engagement : followers > 0 ? parseFloat(((likes / followers) * 100).toFixed(2)) : 0
    };
}

// ── API Routes ────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

/**
 * POST /api/analytics
 * Body: { profiles: { facebook, instagram, twitter, linkedin, youtube, tiktok },
 *         apiKeys:  { youtube, twitter, facebook, instagram, linkedin, tiktok } }
 *
 * API keys in body take priority; env vars are used as fallback.
 */
app.post('/api/analytics', async (req, res) => {
    const { profiles = {}, apiKeys = {} } = req.body || {};

    if (typeof profiles !== 'object') return res.status(400).json({ error: 'profiles must be an object' });

    // Resolve keys: request body first, then env vars
    const keys = {
        youtube   : safe(apiKeys.youtube   || process.env.YOUTUBE_API_KEY   || ''),
        twitter   : safe(apiKeys.twitter   || process.env.TWITTER_BEARER    || ''),
        facebook  : safe(apiKeys.facebook  || process.env.FB_TOKEN          || ''),
        instagram : safe(apiKeys.instagram || process.env.IG_TOKEN          || ''),
        linkedin  : safe(apiKeys.linkedin  || process.env.LINKEDIN_TOKEN    || ''),
        tiktok    : safe(apiKeys.tiktok    || process.env.TIKTOK_TOKEN      || '')
    };

    // Validate all profile URLs
    const ALLOWED = { facebook: ['facebook.com'], instagram: ['instagram.com'], twitter: ['twitter.com', 'x.com'], linkedin: ['linkedin.com'], youtube: ['youtube.com', 'youtu.be'], tiktok: ['tiktok.com'] };
    for (const [platform, rawUrl] of Object.entries(profiles)) {
        if (!rawUrl) continue;
        let hostname;
        try { hostname = new url.URL(rawUrl).hostname.replace(/^www\./, ''); } catch { return res.status(400).json({ error: `Invalid URL for ${platform}` }); }
        if (!ALLOWED[platform]?.some(d => hostname === d || hostname.endsWith('.' + d))) {
            return res.status(400).json({ error: `URL for ${platform} must be on ${ALLOWED[platform].join(' or ')}` });
        }
    }

    // Fetch each platform concurrently
    const fetchers = {
        youtube   : () => profiles.youtube   ? fetchYouTube  (profiles.youtube,   keys.youtube)   : Promise.resolve({ status: 'no_url' }),
        twitter   : () => profiles.twitter   ? fetchTwitter  (profiles.twitter,   keys.twitter)   : Promise.resolve({ status: 'no_url' }),
        facebook  : () => profiles.facebook  ? fetchFacebook (profiles.facebook,  keys.facebook)  : Promise.resolve({ status: 'no_url' }),
        instagram : () => profiles.instagram ? fetchInstagram(profiles.instagram, keys.instagram) : Promise.resolve({ status: 'no_url' }),
        linkedin  : () => profiles.linkedin  ? fetchLinkedIn (profiles.linkedin,  keys.linkedin)  : Promise.resolve({ status: 'no_url' }),
        tiktok    : () => profiles.tiktok    ? fetchTikTok   (profiles.tiktok,    keys.tiktok)    : Promise.resolve({ status: 'no_url' })
    };

    const [ytData, twData, fbData, igData, liData, ttData] = await Promise.allSettled([
        fetchers.youtube(),
        fetchers.twitter(),
        fetchers.facebook(),
        fetchers.instagram(),
        fetchers.linkedin(),
        fetchers.tiktok()
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : { status: 'fetch_error', error: r.reason?.message }));

    const platformResults = {
        youtube  : ytData,
        twitter  : twData,
        facebook : fbData,
        instagram: igData,
        linkedin : liData,
        tiktok   : ttData
    };

    // Aggregate totals from successful platforms only
    let totalFollowers = 0;
    let totalViews     = 0;
    let totalLikes     = 0;
    let totalPosts     = 0;
    let countForEng    = 0;
    let sumEng         = 0;

    for (const d of Object.values(platformResults)) {
        if (d.status === 'ok') {
            totalFollowers += d.followers || 0;
            totalViews     += d.views     || 0;
            totalLikes     += d.likes     || 0;
            totalPosts     += d.posts     || 0;
            if (d.engagement > 0) { sumEng += d.engagement; countForEng++; }
        }
    }

    const avgEngagement = countForEng > 0 ? parseFloat((sumEng / countForEng).toFixed(2)) : 0;

    res.json({
        platforms      : platformResults,
        totalFollowers : totalFollowers,
        totalViews     : totalViews,
        totalLikes     : totalLikes,
        totalPosts     : totalPosts,
        engagementRate : avgEngagement,
        fetchedAt      : new Date().toISOString()
    });
});

/** GET /api/notifications – Today's content notifications */
app.get('/api/notifications', (req, res) => {
    res.json([
        { id: 1, message: 'New comment on your Facebook post',              time: new Date(Date.now() - 15 * 60000).toISOString(), platform: 'facebook'  },
        { id: 2, message: 'Instagram post scheduled for today published',    time: new Date(Date.now() - 30 * 60000).toISOString(), platform: 'instagram' },
        { id: 3, message: 'LinkedIn article reached 500 views',             time: new Date(Date.now() - 60 * 60000).toISOString(), platform: 'linkedin'  },
        { id: 4, message: 'YouTube video hit 1,000 views milestone',        time: new Date(Date.now() - 2 * 3600000).toISOString(), platform: 'youtube'   },
        { id: 5, message: 'Twitter/X post trending in your network',        time: new Date(Date.now() - 3 * 3600000).toISOString(), platform: 'twitter'   },
        { id: 6, message: 'TikTok video gained 500 new followers',          time: new Date(Date.now() - 4 * 3600000).toISOString(), platform: 'tiktok'    }
    ]);
});

/** POST /api/post/:platform – Queue content for posting */
const VALID_PLATFORMS = new Set(['facebook', 'instagram', 'twitter', 'linkedin', 'youtube', 'tiktok']);

app.post('/api/post/:platform', (req, res) => {
    const platform = req.params.platform.toLowerCase();
    if (!VALID_PLATFORMS.has(platform)) return res.status(400).json({ error: `Unknown platform: ${platform}` });

    const { title = '', description = '' } = req.body || {};
    if (!title && !description) return res.status(400).json({ error: 'title or description is required' });

    console.log(`[${new Date().toISOString()}] POST to ${platform}: ${safe(title)}`);
    res.json({ success: true, platform, message: `Content queued for ${platform}`, timestamp: new Date().toISOString() });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Internal server error' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 Kiwami Marketing System – API Server`);
    console.log(`   URL:          http://localhost:${PORT}`);
    console.log(`   Analytics:    POST /api/analytics`);
    console.log(`   Notifs:       GET  /api/notifications`);
    console.log(`   Post content: POST /api/post/:platform\n`);
});
