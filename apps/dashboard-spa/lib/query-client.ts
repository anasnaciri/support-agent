import {
  MutationCache,
  QueryCache,
  QueryClient,
} from "@tanstack/react-query";

import { ApiError, UnauthorizedError } from "./errors";

// A global auth-error handler, wired once the router exists (main.tsx). The RSC
// dashboard `redirect()`-ed on auth/tenant failures; the SPA can't redirect from
// a fetch, so typed errors thrown by the api-client bubble to the query/mutation
// caches here and get routed centrally.
type AuthErrorHandler = (error: unknown) => void;
let authErrorHandler: AuthErrorHandler = () => {};
export const setAuthErrorHandler = (fn: AuthErrorHandler): void => {
  authErrorHandler = fn;
};

// Auth/tenant/config errors are terminal — retrying just repeats the failure.
// Everything else (network blip, 5xx) gets a couple of retries.
const shouldRetry = (failureCount: number, error: unknown): boolean => {
  if (error instanceof ApiError) return false;
  return failureCount < 2;
};

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error) => authErrorHandler(error) }),
  mutationCache: new MutationCache({
    onError: (error) => authErrorHandler(error),
  }),
  defaultOptions: {
    queries: {
      retry: shouldRetry,
      refetchOnWindowFocus: true,
      staleTime: 10_000,
    },
    mutations: { retry: false },
  },
});

export { UnauthorizedError };
