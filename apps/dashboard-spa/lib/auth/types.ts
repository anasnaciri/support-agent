/** The signed-in WorkOS user the BFF whoami returns (mirrors apps/api). */
export interface SessionUser {
  readonly id: string;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
}
