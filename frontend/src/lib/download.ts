/**
 * Saving a fetched file to disk.
 *
 * WHY A BLOB AND A SYNTHETIC LINK RATHER THAN `<a href="http://api/...">`. Auth is an
 * HttpOnly cookie on the API's origin and the app is on another one, so a plain link at
 * the API is a cross-site navigation the session cookie may not travel with - the
 * candidate would get a 401 page in a new tab instead of their resume. `api.blob` fetches
 * it the way every other call is made; this turns the result into a save.
 *
 * The object URL is released on a timer rather than immediately after `click()`. The
 * click only STARTS the download, and a URL revoked in the same tick has been measured to
 * abort it in more than one browser; a few seconds of a held blob is the cheaper mistake.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  // Appended because Firefox ignores a click on a link that is not in the document.
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
