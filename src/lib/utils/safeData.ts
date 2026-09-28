export const safeText = (value: any): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[objeto]";
    }
  }
  return String(value);
};
