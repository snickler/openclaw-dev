// gateway-proxy.mjs — public ingress for OpenClaw.
//
// Responsibilities:
//   - Serves /healthz locally for sandbox/ACA readiness probes.
//   - Routes POST /api/messages to the optional msteams plugin on :3978.
//   - Routes browser UI/API/WebSocket traffic to the OpenClaw gateway on :18788.
//   - Optionally enforces app-owned Entra OIDC auth before proxying browser
//     traffic, then forwards the authenticated user identity to OpenClaw's
//     trusted-proxy auth surface. The browser never receives the gateway token.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import httpProxy from "http-proxy";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";

const PROXY_PORT = Number(process.env.GATEWAY_PROXY_PORT ?? 18789);
const GATEWAY_UPSTREAM = process.env.GATEWAY_UPSTREAM ?? "http://127.0.0.1:18788";
const MSTEAMS_UPSTREAM = process.env.MSTEAMS_UPSTREAM ?? "http://127.0.0.1:3978";
const TEAMS_ENABLED = Boolean((process.env.MSTEAMS_APP_ID ?? "").trim());

const LOGIN_COOKIE_NAME = "__Host-openclaw_oidc_state";
const SESSION_COOKIE_NAME = "__Host-openclaw_session";
const DEFAULT_LOGIN_PATH = "/oidc/login";
const DEFAULT_CALLBACK_PATH = "/oidc/callback";
const DEFAULT_LOGOUT_PATH = "/oidc/logout";
const DEFAULT_BROWSER_AUTH_MODE = "entra-oidc-proxy";
const DEFAULT_OIDC_SCOPES = "openid profile email";
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000;
const LOGIN_COOKIE_SAME_SITE = "None";

const gatewayProxy = httpProxy.createProxyServer({
    target: GATEWAY_UPSTREAM,
    ws: true,
    xfwd: true,
    changeOrigin: false,
});

const msteamsProxy = httpProxy.createProxyServer({
    target: MSTEAMS_UPSTREAM,
    xfwd: true,
    changeOrigin: false,
});

const browserAuth = createBrowserAuthConfig();
const pendingLogins = new Map();
const sessions = new Map();
let oidcKeySet = null;

if (browserAuth) {
    console.log(`[gateway-proxy] browser auth mode: ${browserAuth.mode}`);
    console.log(`[gateway-proxy] public base url: ${browserAuth.publicBaseUrl.toString()}`);
    console.log(`[gateway-proxy] browser auth allowlist users=${browserAuth.allowedUsers.length} objectIds=${browserAuth.allowedObjectIds.length}`);
    try {
        if (browserAuth.jwksJson) {
            oidcKeySet = createLocalJWKSet(JSON.parse(browserAuth.jwksJson));
        } else if (browserAuth.jwksPath) {
            const jwksDocument = JSON.parse(fs.readFileSync(browserAuth.jwksPath, "utf8"));
            oidcKeySet = createLocalJWKSet(jwksDocument);
        } else {
            oidcKeySet = createRemoteJWKSet(new URL(browserAuth.jwksUri));
        }
    } catch (err) {
        console.error(`[gateway-proxy] Failed to initialize OIDC signing keys: ${err?.message ?? err}`);
        process.exit(2);
    }
}

function createBrowserAuthConfig() {
    const mode = (process.env.BROWSER_AUTH_MODE ?? "").trim().toLowerCase();
    if (mode && mode !== DEFAULT_BROWSER_AUTH_MODE && mode !== "disabled") {
        console.error(`[gateway-proxy] Unsupported BROWSER_AUTH_MODE=${mode}`);
        process.exit(2);
    }
    if (mode === "disabled") return null;

    const requiredKeys = [
        "PUBLIC_BASE_URL",
        "BROWSER_AUTH_CLIENT_ID",
        "BROWSER_AUTH_TENANT_ID",
        "BROWSER_AUTH_SESSION_SECRET",
    ];
    const hasAnyOidcSetting = requiredKeys.some((key) => Boolean((process.env[key] ?? "").trim()));
    if (!hasAnyOidcSetting && !mode) {
        return null;
    }

    const missing = requiredKeys.filter((key) => !String(process.env[key] ?? "").trim());
    if (missing.length > 0) {
        console.error(`[gateway-proxy] Missing browser auth settings: ${missing.join(", ")}`);
        process.exit(2);
    }

    let publicBaseUrl;
    try {
        publicBaseUrl = new URL(String(process.env.PUBLIC_BASE_URL));
    } catch (err) {
        console.error(`[gateway-proxy] Invalid PUBLIC_BASE_URL: ${err?.message ?? err}`);
        process.exit(2);
    }
    if (publicBaseUrl.protocol !== "https:") {
        console.error("[gateway-proxy] PUBLIC_BASE_URL must use https");
        process.exit(2);
    }

    const tenantId = String(process.env.BROWSER_AUTH_TENANT_ID).trim();
    const issuer = (process.env.BROWSER_AUTH_ISSUER ?? `https://login.microsoftonline.com/${tenantId}/v2.0`)
        .trim()
        .replace(/\/+$/, "");
    const allowedUsers = parseDelimitedList(
        process.env.BROWSER_AUTH_ALLOWED_USERS
        ?? process.env.BROWSER_AUTH_ALLOWED_PRINCIPALS
        ?? "",
    ).map(normalizePrincipal);
    const allowedObjectIds = parseDelimitedList(process.env.BROWSER_AUTH_ALLOWED_OBJECT_IDS ?? "").map(normalizePrincipal);
    if (allowedUsers.length === 0 && allowedObjectIds.length === 0) {
        console.error("[gateway-proxy] Browser auth allowlist is required. Set BROWSER_AUTH_ALLOWED_USERS and/or BROWSER_AUTH_ALLOWED_OBJECT_IDS.");
        process.exit(2);
    }
    const loginPath = normalizePath(process.env.BROWSER_AUTH_LOGIN_PATH, DEFAULT_LOGIN_PATH);
    const callbackPath = normalizePath(process.env.BROWSER_AUTH_CALLBACK_PATH, DEFAULT_CALLBACK_PATH);
    const logoutPath = normalizePath(process.env.BROWSER_AUTH_LOGOUT_PATH, DEFAULT_LOGOUT_PATH);
    const sessionTtlMs = parsePositiveInt(process.env.BROWSER_AUTH_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS);

    return {
        mode: mode || DEFAULT_BROWSER_AUTH_MODE,
        publicBaseUrl,
        publicOrigin: publicBaseUrl.origin,
        publicHost: publicBaseUrl.host,
        publicProtocol: publicBaseUrl.protocol.replace(/:$/, ""),
        issuer,
        tenantId,
        clientId: String(process.env.BROWSER_AUTH_CLIENT_ID).trim(),
        authorizationEndpoint: (process.env.BROWSER_AUTH_AUTHORIZATION_ENDPOINT
            ?? `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`).trim(),
        jwksUri: (process.env.BROWSER_AUTH_JWKS_URI
            ?? `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`).trim(),
        jwksJson: String(process.env.BROWSER_AUTH_JWKS_JSON ?? "").trim(),
        jwksPath: String(process.env.BROWSER_AUTH_JWKS_PATH ?? "").trim(),
        sessionSecret: String(process.env.BROWSER_AUTH_SESSION_SECRET),
        allowedUsers,
        allowedObjectIds,
        scopes: (process.env.BROWSER_AUTH_SCOPES ?? DEFAULT_OIDC_SCOPES).trim() || DEFAULT_OIDC_SCOPES,
        loginPath,
        callbackPath,
        logoutPath,
        redirectUri: new URL(callbackPath, publicBaseUrl).toString(),
        sessionTtlMs,
    };
}

function normalizePath(value, fallback) {
    const raw = String(value ?? "").trim() || fallback;
    const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
    try {
        return new URL(withLeadingSlash, "https://openclaw.local").pathname;
    } catch {
        return fallback;
    }
}

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDelimitedList(value) {
    return [...new Set(
        String(value ?? "")
            .split(/[,\r\n;]+/)
            .map((item) => item.trim())
            .filter(Boolean),
    )];
}

function normalizePrincipal(value) {
    return stringClaim(value).toLowerCase();
}

function onProxyError(label) {
    return (err, _req, res) => {
        console.error(`[gateway-proxy] ${label} upstream error: ${err?.message ?? err}`);
        if (res && typeof res.writeHead === "function" && !res.headersSent) {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("Bad Gateway");
        } else if (res && typeof res.end === "function") {
            try { res.end(); } catch { /* socket already closed */ }
        }
    };
}

gatewayProxy.on("error", onProxyError("gateway"));
msteamsProxy.on("error", onProxyError("msteams"));

gatewayProxy.on("proxyReq", (proxyReq, req) => {
    if (browserAuth && req.__openclawSession) {
        applyTrustedProxyHeaders(proxyReq, req.__openclawSession);
    }
});

gatewayProxy.on("proxyReqWs", (proxyReq, req) => {
    if (browserAuth && req.__openclawSession) {
        applyTrustedProxyHeaders(proxyReq, req.__openclawSession);
    }
});

function requestPath(url) {
    if (!url) return "";
    try {
        return new URL(url, "http://gateway-proxy.local").pathname;
    } catch {
        return "";
    }
}

function isBotFrameworkPath(url) {
    return requestPath(url) === "/api/messages";
}

function isHealthPath(url) {
    return requestPath(url) === "/healthz";
}

function isUnsafeMethod(method) {
    const normalized = String(method ?? "GET").toUpperCase();
    return !["GET", "HEAD", "OPTIONS"].includes(normalized);
}

function parseCookies(cookieHeader) {
    const cookies = {};
    for (const part of String(cookieHeader ?? "").split(";")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const name = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (!name) continue;
        try {
            cookies[name] = decodeURIComponent(value);
        } catch {
            cookies[name] = value;
        }
    }
    return cookies;
}

function serializeCookie(name, value, options = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    parts.push(`Path=${options.path ?? "/"}`);
    if (typeof options.maxAge === "number") {
        parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
    }
    if (options.expires instanceof Date) {
        parts.push(`Expires=${options.expires.toUTCString()}`);
    }
    if (options.httpOnly !== false) {
        parts.push("HttpOnly");
    }
    if (options.secure !== false) {
        parts.push("Secure");
    }
    if (options.sameSite) {
        parts.push(`SameSite=${options.sameSite}`);
    }
    return parts.join("; ");
}

function appendSetCookie(res, cookieValue) {
    const existing = res.getHeader("Set-Cookie");
    if (!existing) {
        res.setHeader("Set-Cookie", cookieValue);
        return;
    }
    if (Array.isArray(existing)) {
        res.setHeader("Set-Cookie", [...existing, cookieValue]);
        return;
    }
    res.setHeader("Set-Cookie", [existing, cookieValue]);
}

function writeJson(res, statusCode, body, headers = {}) {
    if (res.headersSent) return;
    res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        ...headers,
    });
    res.end(JSON.stringify(body));
}

function writeText(res, statusCode, body, headers = {}) {
    if (res.headersSent) return;
    res.writeHead(statusCode, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        ...headers,
    });
    res.end(body);
}

function redirect(res, location, statusCode = 302) {
    if (res.headersSent) return;
    res.writeHead(statusCode, {
        "Location": location,
        "Cache-Control": "no-store",
    });
    res.end();
}

function rejectUpgrade(socket, statusCode = 400) {
    try {
        if (socket.writable) {
            const statusText = {
                400: "Bad Request",
                401: "Unauthorized",
                403: "Forbidden",
            }[statusCode] ?? "Bad Request";
            socket.end(`HTTP/1.1 ${statusCode} ${statusText}\r
Connection: close\r
Content-Length: 0\r
\r
`);
        } else {
            socket.destroy();
        }
    } catch {
        try { socket.destroy(); } catch { /* already closed */ }
    }
}

export function sanitizeReturnTo(value) {
    let decodedValue;
    if (typeof value !== "string") return "/";
    if (/%5c/i.test(value)) return "/";
    try {
        decodedValue = decodeURIComponent(value);
    } catch {
        return "/";
    }
    if (decodedValue.includes("\\") || /%5c/i.test(decodedValue)) return "/";

    let parsed;
    try {
        parsed = new URL(decodedValue, "https://openclaw.local");
    } catch {
        return "/";
    }

    if (parsed.origin !== "https://openclaw.local") return "/";
    const relativePath = `${parsed.pathname}${parsed.search}`;
    if (!relativePath.startsWith("/") || relativePath.startsWith("//") || relativePath.includes("\\")) return "/";
    return relativePath;
}

function currentRequestTarget(req) {
    try {
        const url = new URL(req.url ?? "/", browserAuth?.publicBaseUrl ?? "https://openclaw.local");
        return sanitizeReturnTo(`${url.pathname}${url.search}`);
    } catch {
        return "/";
    }
}

function randomOpaqueValue(bytes = 32) {
    return crypto.randomBytes(bytes).toString("base64url");
}

function signCookieValue(value) {
    const signature = crypto
        .createHmac("sha256", browserAuth.sessionSecret)
        .update(value)
        .digest("base64url");
    return `${value}.${signature}`;
}

function verifySignedCookieValue(signedValue) {
    if (!browserAuth || typeof signedValue !== "string") return "";
    const separator = signedValue.lastIndexOf(".");
    if (separator <= 0 || separator === signedValue.length - 1) return "";
    const value = signedValue.slice(0, separator);
    const supplied = signedValue.slice(separator + 1);
    const expected = crypto
        .createHmac("sha256", browserAuth.sessionSecret)
        .update(value)
        .digest("base64url");
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);
    if (suppliedBuffer.length !== expectedBuffer.length) return "";
    if (!crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) return "";
    return value;
}

function storePendingLogin(returnTo) {
    const state = randomOpaqueValue();
    const nonce = randomOpaqueValue();
    const expiresAt = Date.now() + PENDING_LOGIN_TTL_MS;
    pendingLogins.set(state, {
        state,
        nonce,
        returnTo,
        expiresAt,
    });
    return { state, nonce, expiresAt };
}

function readPendingLogin(state) {
    const pending = pendingLogins.get(state);
    if (!pending) return null;
    if (pending.expiresAt <= Date.now()) {
        pendingLogins.delete(state);
        return null;
    }
    return pending;
}

function consumePendingLogin(state) {
    const pending = readPendingLogin(state);
    pendingLogins.delete(state);
    return pending;
}

function createSession(claims) {
    const now = Date.now();
    const tokenExpiryMs = Number(claims.exp ?? 0) * 1000;
    const expiresAt = Number.isFinite(tokenExpiryMs) && tokenExpiryMs > now
        ? Math.min(tokenExpiryMs, now + browserAuth.sessionTtlMs)
        : now + browserAuth.sessionTtlMs;
    const userHeaderValue = selectUserHeaderValue(claims);
    const sessionId = randomOpaqueValue();
    sessions.set(sessionId, {
        userHeaderValue,
        email: stringClaim(claims.preferred_username) || stringClaim(claims.email) || stringClaim(claims.upn),
        name: stringClaim(claims.name),
        oid: stringClaim(claims.oid) || stringClaim(claims.sub),
        tenantId: stringClaim(claims.tid),
        expiresAt,
    });
    return sessionId;
}

function readSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = verifySignedCookieValue(cookies[SESSION_COOKIE_NAME]);
    if (!sessionId) return null;
    const session = sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        sessions.delete(sessionId);
        return null;
    }
    return { id: sessionId, ...session };
}

function deleteSession(sessionId) {
    if (sessionId) {
        sessions.delete(sessionId);
    }
}

function stringClaim(value) {
    return typeof value === "string" && value.trim() ? value.trim() : "";
}

function selectUserHeaderValue(claims) {
    return stringClaim(claims.preferred_username)
        || stringClaim(claims.email)
        || stringClaim(claims.upn)
        || stringClaim(claims.oid)
        || stringClaim(claims.sub);
}

function principalCandidates(claims) {
    return [...new Set(
        [
            stringClaim(claims.preferred_username),
            stringClaim(claims.email),
            stringClaim(claims.upn),
        ]
            .map((value) => value.toLowerCase())
            .filter(Boolean),
    )];
}

function objectIdCandidates(claims) {
    return [...new Set(
        [
            stringClaim(claims.oid),
            stringClaim(claims.sub),
        ]
            .map((value) => value.toLowerCase())
            .filter(Boolean),
    )];
}

function isAllowedPrincipal(claims) {
    const principalMatches = principalCandidates(claims);
    const objectIdMatches = objectIdCandidates(claims);
    const matchedPrincipal = principalMatches.find((value) => browserAuth.allowedUsers.includes(value));
    const matchedObjectId = objectIdMatches.find((value) => browserAuth.allowedObjectIds.includes(value));
    const allowed = Boolean(matchedPrincipal || matchedObjectId);
    return {
        allowed,
        matchedPrincipal,
        matchedObjectId,
        principalMatches,
        objectIdMatches,
    };
}

function getOriginHeader(req) {
    return stringClaim(req.headers.origin);
}

function validateHttpOrigin(req, res) {
    if (!browserAuth) return true;
    const origin = getOriginHeader(req);
    if (!origin) {
        if (isUnsafeMethod(req.method)) {
            writeText(res, 403, "origin-required");
            return false;
        }
        return true;
    }
    if (origin !== browserAuth.publicOrigin) {
        writeText(res, 403, "origin-forbidden");
        return false;
    }
    return true;
}

function validateWebSocketOrigin(req, socket) {
    if (!browserAuth) return true;
    const origin = getOriginHeader(req);
    if (!origin || origin !== browserAuth.publicOrigin) {
        rejectUpgrade(socket, 403);
        return false;
    }
    return true;
}

function attachSessionToRequest(req, session) {
    if (!browserAuth || !session) return;
    req.__openclawSession = session;
    req.headers.host = browserAuth.publicHost;
    req.headers["x-openclaw-authenticated"] = "1";
    req.headers["x-forwarded-proto"] = browserAuth.publicProtocol;
    req.headers["x-forwarded-host"] = browserAuth.publicHost;
    req.headers["x-forwarded-user"] = session.userHeaderValue;
    if (session.email) req.headers["x-forwarded-email"] = session.email;
    if (session.name) req.headers["x-forwarded-name"] = session.name;
    if (session.oid) req.headers["x-forwarded-oid"] = session.oid;
    if (session.tenantId) req.headers["x-forwarded-tenant-id"] = session.tenantId;
    delete req.headers.authorization;
}

function applyTrustedProxyHeaders(proxyReq, session) {
    proxyReq.setHeader("host", browserAuth.publicHost);
    proxyReq.setHeader("x-openclaw-authenticated", "1");
    proxyReq.setHeader("x-forwarded-proto", browserAuth.publicProtocol);
    proxyReq.setHeader("x-forwarded-host", browserAuth.publicHost);
    proxyReq.setHeader("x-forwarded-user", session.userHeaderValue);
    if (session.email) proxyReq.setHeader("x-forwarded-email", session.email);
    if (session.name) proxyReq.setHeader("x-forwarded-name", session.name);
    if (session.oid) proxyReq.setHeader("x-forwarded-oid", session.oid);
    if (session.tenantId) proxyReq.setHeader("x-forwarded-tenant-id", session.tenantId);
    proxyReq.removeHeader("authorization");
}

async function buildAuthorizeUrl(returnTo) {
    const pending = storePendingLogin(returnTo);
    const authorizeUrl = new URL(browserAuth.authorizationEndpoint);
    authorizeUrl.search = new URLSearchParams({
        client_id: browserAuth.clientId,
        response_type: "id_token",
        redirect_uri: browserAuth.redirectUri,
        response_mode: "form_post",
        scope: browserAuth.scopes,
        state: pending.state,
        nonce: pending.nonce,
    }).toString();
    return { authorizeUrl: authorizeUrl.toString(), pending };
}
async function validateIdToken(idToken, pending) {
    if (!oidcKeySet) {
        throw new Error("jwks not initialized");
    }
    const { payload: claims } = await jwtVerify(idToken, oidcKeySet, {
        issuer: browserAuth.issuer,
        audience: browserAuth.clientId,
    });
    if (stringClaim(claims.tid) !== browserAuth.tenantId) {
        throw new Error("tenant mismatch");
    }
    if (stringClaim(claims.nonce) !== pending.nonce) {
        throw new Error("nonce mismatch");
    }
    return claims;
}

async function readRequestBody(req, limitBytes = 32 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > limitBytes) {
            throw new Error("request body too large");
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function cleanupExpiredState() {
    const now = Date.now();
    for (const [state, pending] of pendingLogins.entries()) {
        if (pending.expiresAt <= now) {
            pendingLogins.delete(state);
        }
    }
    for (const [sessionId, session] of sessions.entries()) {
        if (session.expiresAt <= now) {
            sessions.delete(sessionId);
        }
    }
}

setInterval(cleanupExpiredState, 60_000).unref();

async function handleLogin(req, res) {
    const existingSession = readSession(req);
    const url = new URL(req.url ?? "/", browserAuth.publicBaseUrl);
    const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo") ?? "/");
    if (existingSession) {
        redirect(res, returnTo);
        return;
    }
    let authorizeUrl;
    let pending;
    try {
        ({ authorizeUrl, pending } = await buildAuthorizeUrl(returnTo));
    } catch (err) {
        console.error(`[gateway-proxy] login-init failed: ${err?.message ?? err}`);
        writeText(res, 502, "oidc-login-init-failed");
        return;
    }
    const signedState = signCookieValue(pending.state);
    appendSetCookie(res, serializeCookie(LOGIN_COOKIE_NAME, signedState, {
        path: '/',
        maxAge: Math.floor(PENDING_LOGIN_TTL_MS / 1000),
        httpOnly: true,
        secure: true,
        // Entra returns the id_token to /oidc/callback via a top-level cross-site
        // form POST (response_mode=form_post). SameSite=Lax would suppress this
        // state cookie on that POST and break CSRF/state validation.
        sameSite: LOGIN_COOKIE_SAME_SITE,
    }));
    redirect(res, authorizeUrl);
}

async function handleCallback(req, res) {
    const url = new URL(req.url ?? browserAuth.callbackPath, browserAuth.publicBaseUrl);
    const cookies = parseCookies(req.headers.cookie);
    const cookieState = verifySignedCookieValue(cookies[LOGIN_COOKIE_NAME] ?? "");
    appendSetCookie(res, serializeCookie(LOGIN_COOKIE_NAME, "", {
        path: '/',
        maxAge: 0,
        expires: new Date(0),
        httpOnly: true,
        secure: true,
        sameSite: LOGIN_COOKIE_SAME_SITE,
    }));

    let callbackParams = url.searchParams;
    if (String(req.method ?? "GET").toUpperCase() === "POST") {
        try {
            callbackParams = new URLSearchParams(await readRequestBody(req));
        } catch (err) {
            console.error(`[gateway-proxy] callback body read failed: ${err?.message ?? err}`);
            writeText(res, 400, "oidc-callback-invalid");
            return;
        }
    }

    if (callbackParams.has("error")) {
        writeText(res, 401, `oidc-error: ${callbackParams.get("error") ?? "login_failed"}`);
        return;
    }

    const idToken = callbackParams.get("id_token") ?? "";
    const state = callbackParams.get("state") ?? "";
    if (!idToken || !state || !cookieState || cookieState !== state) {
        writeText(res, 400, "oidc-state-invalid");
        return;
    }

    const pending = consumePendingLogin(state);
    if (!pending) {
        writeText(res, 400, "oidc-state-expired");
        return;
    }

    let claims;
    try {
        claims = await validateIdToken(idToken, pending);
    } catch (err) {
        console.error(`[gateway-proxy] callback failed: ${err?.message ?? err}`);
        writeText(res, 401, "oidc-callback-failed");
        return;
    }

    const allowlistDecision = isAllowedPrincipal(claims);
    if (!allowlistDecision.allowed) {
        console.warn(
            `[gateway-proxy] principal denied by allowlist: principals=${allowlistDecision.principalMatches.join("|") || "<none>"} objectIds=${allowlistDecision.objectIdMatches.join("|") || "<none>"}`,
        );
        writeText(res, 403, "principal-not-allowed");
        return;
    }

    const sessionId = createSession(claims);
    appendSetCookie(res, serializeCookie(SESSION_COOKIE_NAME, signCookieValue(sessionId), {
        path: "/",
        maxAge: Math.floor(browserAuth.sessionTtlMs / 1000),
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
    }));
    redirect(res, pending.returnTo || "/");
}

function handleLogout(req, res) {
    const session = readSession(req);
    if (session?.id) {
        deleteSession(session.id);
    }
    appendSetCookie(res, serializeCookie(SESSION_COOKIE_NAME, "", {
        path: "/",
        maxAge: 0,
        expires: new Date(0),
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
    }));
    redirect(res, browserAuth.loginPath);
}

function requireSession(req, res) {
    const session = readSession(req);
    if (session) {
        return session;
    }
    if (["GET", "HEAD"].includes(String(req.method ?? "GET").toUpperCase())) {
        const returnTo = currentRequestTarget(req);
        redirect(res, `${browserAuth.loginPath}?returnTo=${encodeURIComponent(returnTo)}`);
        return null;
    }
    writeText(res, 401, "authentication-required");
    return null;
}

async function handleHttpRequest(req, res) {
    if (isHealthPath(req.url)) {
        writeJson(res, 200, { status: "ok" });
        return;
    }

    if (isBotFrameworkPath(req.url)) {
        if (!TEAMS_ENABLED) {
            writeText(res, 404, "Not Found");
            return;
        }
        if (req.method !== "POST") {
            res.writeHead(405, { "Allow": "POST", "Content-Type": "text/plain" });
            res.end("Method Not Allowed");
            return;
        }
        msteamsProxy.web(req, res);
        return;
    }

    if (!browserAuth) {
        gatewayProxy.web(req, res);
        return;
    }

    const path = requestPath(req.url);
    if (path === browserAuth.loginPath) {
        await handleLogin(req, res);
        return;
    }
    if (path === browserAuth.callbackPath) {
        await handleCallback(req, res);
        return;
    }
    if (path === browserAuth.logoutPath) {
        handleLogout(req, res);
        return;
    }

    if (!validateHttpOrigin(req, res)) {
        return;
    }

    const session = requireSession(req, res);
    if (!session) {
        return;
    }

    attachSessionToRequest(req, session);
    gatewayProxy.web(req, res);
}

export const server = http.createServer((req, res) => {
    handleHttpRequest(req, res).catch((err) => {
        console.error(`[gateway-proxy] request failed: ${err?.stack ?? err}`);
        if (!res.headersSent) {
            writeText(res, 500, "Internal Server Error");
        } else {
            try { res.end(); } catch { /* already closed */ }
        }
    });
});

server.on("upgrade", (req, socket, head) => {
    if (isBotFrameworkPath(req.url) || isHealthPath(req.url)) {
        rejectUpgrade(socket, 400);
        return;
    }
    if (!browserAuth) {
        gatewayProxy.ws(req, socket, head);
        return;
    }

    const path = requestPath(req.url);
    if ([browserAuth.loginPath, browserAuth.callbackPath, browserAuth.logoutPath].includes(path)) {
        rejectUpgrade(socket, 400);
        return;
    }
    if (!validateWebSocketOrigin(req, socket)) {
        return;
    }

    const session = readSession(req);
    if (!session) {
        rejectUpgrade(socket, 401);
        return;
    }

    attachSessionToRequest(req, session);
    gatewayProxy.ws(req, socket, head);
});

server.on("clientError", (_err, socket) => {
    if (socket.writable) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
});

if (process.env.GATEWAY_PROXY_AUTOSTART !== "false") {
    server.listen(PROXY_PORT, "0.0.0.0", () => {
        console.log(`[gateway-proxy] listening on 0.0.0.0:${PROXY_PORT}`);
        console.log(`[gateway-proxy]   /api/messages -> ${MSTEAMS_UPSTREAM}`);
        console.log(`[gateway-proxy]   *             -> ${GATEWAY_UPSTREAM}`);
        if (browserAuth) {
            console.log(`[gateway-proxy]   browser auth enabled at ${browserAuth.loginPath}`);
        } else {
            console.log(`[gateway-proxy]   browser auth disabled`);
        }
    });

    for (const signal of ["SIGINT", "SIGTERM"]) {
        process.on(signal, () => {
            console.log(`[gateway-proxy] ${signal} — closing`);
            server.close(() => process.exit(0));
        });
    }
}
