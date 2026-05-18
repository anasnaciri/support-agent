"use client";

import { useActionState } from "react";
import { createTenantAction } from "./actions";

// Client wrapper around the server action so we can surface validation
// errors inline without navigating away. `useActionState` handles the
// pending state + error transitions; the server action returns
// `{ error?: string }`.

interface Props {
  readonly defaultEmail: string | null;
}

export const OnboardingForm = ({ defaultEmail }: Props) => {
  const [state, formAction, pending] = useActionState(
    createTenantAction,
    null as { readonly error?: string } | null,
  );

  return (
    <form action={formAction} className="edit-and-approve">
      <label>
        Team name
        <input
          type="text"
          name="name"
          required
          minLength={2}
          maxLength={120}
          placeholder="Acme Support"
          disabled={pending}
        />
      </label>
      <label>
        Notification email (for approval requests)
        <input
          type="email"
          name="notificationEmail"
          required
          defaultValue={defaultEmail ?? ""}
          disabled={pending}
        />
      </label>
      {state?.error ? (
        <p className="banner warn" style={{ margin: 0 }}>
          {state.error}
        </p>
      ) : null}
      <div className="approval-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={pending}
        >
          {pending ? "Creating…" : "Create tenant & continue"}
        </button>
      </div>
    </form>
  );
};
