/** Replace one unique occurrence. Empty or repeated needles would corrupt the file. */
export function applyUniquePatch(
  text: string,
  oldString: string,
  newString: string
): string {
  if (!oldString) throw new Error("old_string is empty");
  const first = text.indexOf(oldString);
  if (first < 0) throw new Error("old_string not found");
  const second = text.indexOf(oldString, first + oldString.length);
  if (second >= 0) throw new Error("old_string is not unique");
  return text.slice(0, first) + newString + text.slice(first + oldString.length);
}
