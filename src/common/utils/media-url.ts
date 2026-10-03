/**
 * Customer media (PHOTO customizations) must live in our own upload bucket.
 * The server fetches these URLs when zipping media for the admin, so accepting
 * any URL would let a public form point the server at internal addresses.
 *
 * Allowed: the configured `S3_PUBLIC_BASE_URL` (host, and path prefix when it
 * has one) and the bucket's own virtual-hosted amazonaws host.
 */
export function allowedMediaBases(env: NodeJS.ProcessEnv = process.env): URL[] {
  const bases: URL[] = [];
  const add = (raw?: string) => {
    if (!raw) return;
    try {
      bases.push(new URL(raw));
    } catch {
      // A malformed setting allows nothing rather than everything.
    }
  };
  add(env.S3_PUBLIC_BASE_URL?.trim());
  const bucket = env.S3_BUCKET?.trim();
  if (bucket) {
    const region = env.AWS_REGION?.trim() || 'ap-south-1';
    add(`https://${bucket}.s3.${region}.amazonaws.com`);
    add(`https://${bucket}.s3.amazonaws.com`);
  }
  return bases;
}

export function isAllowedMediaUrl(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof raw !== 'string' || !raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return allowedMediaBases(env).some((base) => {
    if (url.protocol !== base.protocol) return false;
    // `host` includes the port, so a non-default port never matches.
    if (url.host.toLowerCase() !== base.host.toLowerCase()) return false;
    const prefix = base.pathname.endsWith('/')
      ? base.pathname
      : `${base.pathname}/`;
    return base.pathname === '/' || url.pathname.startsWith(prefix);
  });
}
