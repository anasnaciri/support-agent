interface CanonicalSignInInput {
  readonly requestUrl: string;
  readonly redirectUri: string | undefined;
}

const parseUrl = (value: string | undefined): URL | null => {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

export const canonicalSignInUrl = ({
  requestUrl,
  redirectUri,
}: CanonicalSignInInput): string | null => {
  const request = parseUrl(requestUrl);
  const callback = parseUrl(redirectUri);
  if (!request || !callback || request.origin === callback.origin) {
    return null;
  }

  const canonical = new URL(`${request.pathname}${request.search}`, callback);
  return canonical.toString();
};
