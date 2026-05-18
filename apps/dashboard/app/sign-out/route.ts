import { signOut } from "@workos-inc/authkit-nextjs";

// Clears the session cookie + redirects to the WorkOS-configured
// logout URI (set in the WorkOS dashboard under Redirects).
export const GET = async () => signOut();
