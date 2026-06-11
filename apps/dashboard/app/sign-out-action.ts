"use server";

import { signOut } from "@workos-inc/authkit-nextjs";

// Sign-out is a server action, not a GET route (S13): logging out mutates
// state (cookie + WorkOS session termination), so it must not be triggerable
// by a drive-by GET / link prefetch. AuthKit's signOut clears the session
// cookie and redirects to the WorkOS-configured logout URI.
export const signOutAction = async (): Promise<void> => signOut();
