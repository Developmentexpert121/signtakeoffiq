export function extractDriveFileId(shareUrl: string): string | null {
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = shareUrl.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export async function downloadFromGoogleDrive(
  shareUrl: string,
): Promise<{ buffer: Buffer; filename: string; contentType: string; sizeBytes: number }> {
  const fileId = extractDriveFileId(shareUrl);
  if (!fileId) throw new Error("Invalid Google Drive URL — could not extract file ID");

  const fetchWithHeaders = (url: string) => fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SignTakeoffIQ/1.0)" },
  });

  let response = await fetchWithHeaders(
    `https://drive.google.com/uc?export=download&id=${fileId}`
  );

  if ((response.headers.get("content-type") ?? "").includes("text/html")) {
    const html = await response.text();

    if (html.includes("accounts.google.com") || html.includes("Sign in")) {
      throw new Error(
        "File is not publicly accessible. In Google Drive click Share → change to 'Anyone with the link can view' → copy link."
      );
    }

    response = await fetchWithHeaders(
      `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`
    );

    if ((response.headers.get("content-type") ?? "").includes("text/html")) {
      const confirmMatch = html.match(/confirm=([a-zA-Z0-9_-]+)/)
        ?? html.match(/name="confirm" value="([^"]+)"/);
      if (confirmMatch) {
        response = await fetchWithHeaders(
          `https://drive.google.com/uc?export=download&id=${fileId}&confirm=${confirmMatch[1]}`
        );
      }
    }

    if ((response.headers.get("content-type") ?? "").includes("text/html")) {
      throw new Error(
        "Could not download from Google Drive. Ensure the file is shared as 'Anyone with the link can view' and try again."
      );
    }
  }

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        'Google Drive permission denied (403). Open the file in Drive, click Share → "Anyone with the link" → Viewer, then retry.'
      );
    }
    if (response.status === 404) {
      throw new Error(
        "Google Drive file not found (404). Check that the link is correct and the file has not been deleted or moved."
      );
    }
    throw new Error(`Google Drive download failed: ${response.status} ${response.statusText}`);
  }

  const finalContentType = response.headers.get("content-type") ?? "application/octet-stream";
  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename[^;=\n]*=\s*["']?([^"';\n]+)/i);
  const filename = filenameMatch?.[1]?.trim() ?? `drive-file-${fileId}.pdf`;

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length < 10_000) {
    throw new Error(
      "Downloaded file is too small to be a valid PDF. Check that the link points to a PDF and sharing is set to public."
    );
  }

  if (!buffer.slice(0, 4).toString("ascii").startsWith("%PDF")) {
    throw new Error(
      "Downloaded file is not a valid PDF. Make sure the Google Drive link points directly to a PDF file."
    );
  }

  console.log(`[googleDrive] Downloaded: ${filename} — ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);

  return { buffer, filename, contentType: finalContentType, sizeBytes: buffer.length };
}
