export const approvalDisplayNote = (
  context: Readonly<Record<string, unknown>>,
): string | null => {
  const notes = context["notes"];
  if (typeof notes !== "string") return null;
  return notes.trim().length > 0 ? notes : null;
};
