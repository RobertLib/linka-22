// Explicit gzip assets also work on static hosts that cannot set Content-Encoding.
// Keep the originals as a fallback for browsers without streaming decompression.
async function assetResponse(url) {
  if (typeof DecompressionStream !== "undefined") {
    const response = await fetch(`${url}.gz`);
    if (response.ok) {
      if (/gzip/i.test(response.headers.get("content-encoding") ?? ""))
        return response;
      return new Response(
        response.body.pipeThrough(new DecompressionStream("gzip")),
      );
    }
    if (response.status !== 404)
      throw new Error(`Načítání ${url}: ${response.status}`);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Načítání ${url}: ${response.status}`);
  return response;
}

export async function loadJSON(url) {
  return (await assetResponse(url)).json();
}

export async function loadBinary(url) {
  return (await assetResponse(url)).arrayBuffer();
}
