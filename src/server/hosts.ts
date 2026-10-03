import type { IncomingMessage } from "node:http";

export type RequestOrigin = { origin: string; remote: boolean; port: number };

/** Hosts reachable through a trusted HTTPS tunnel, e.g. `PI_MOBILE_ALLOWED_HOSTS=pim.ngrok.pro`. */
export function parseAllowedHosts(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
}

// The server only listens on loopback. Local hosts are served over http; an
// allowed tunnel host must be https (the tunnel terminates TLS and authenticates).
// Any other Host header is rejected, which blocks DNS rebinding.
export function requestOrigin(request: IncomingMessage, remoteHosts: readonly string[]): RequestOrigin | undefined {
	const port = request.socket.localPort ?? 0;
	if (request.socket.localAddress !== "127.0.0.1") return undefined;
	const host = request.headers.host?.toLowerCase() ?? "";
	if (host === `127.0.0.1:${port}` || host === `localhost:${port}`)
		return { origin: `http://${host}`, remote: false, port };
	if (remoteHosts.includes(host)) return { origin: `https://${host}`, remote: true, port };
	return undefined;
}
