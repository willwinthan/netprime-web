export function allowedOrigins(value?: string): string[] {
  return (value || "").split(",").map(origin => origin.trim()).filter(Boolean);
}

export function validOAuthRedirect(uri: string, provider: string, origins?: string): boolean {
  try {
    const url = new URL(uri);
    return allowedOrigins(origins).includes(url.origin) && !url.username && !url.password &&
      url.pathname === `/auth/callback/${provider}` && !url.search && !url.hash;
  } catch { return false; }
}
