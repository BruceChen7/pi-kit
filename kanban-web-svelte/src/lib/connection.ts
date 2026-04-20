export function validateRuntimeConnection(input: {
  baseUrl: string;
  token: string;
}): string | null {
  if (!input.baseUrl.trim()) {
    return "Runtime base URL is required.";
  }

  return null;
}
