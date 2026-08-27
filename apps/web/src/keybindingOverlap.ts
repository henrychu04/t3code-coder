import type { KeybindingWhenNode } from "@t3tools/contracts";
import { parseKeybindingWhenExpression } from "@t3tools/shared/keybindings";

function collectIdentifiers(node: KeybindingWhenNode | undefined, into: Set<string>): void {
  if (!node) return;
  if (node.type === "identifier") {
    if (node.name !== "true" && node.name !== "false") into.add(node.name);
    return;
  }
  if (node.type === "not") collectIdentifiers(node.node, into);
  else {
    collectIdentifiers(node.left, into);
    collectIdentifiers(node.right, into);
  }
}

function evaluate(
  node: KeybindingWhenNode | undefined,
  values: ReadonlyMap<string, boolean>,
): boolean {
  if (!node) return true;
  switch (node.type) {
    case "identifier":
      return node.name === "true" || (node.name !== "false" && values.get(node.name) === true);
    case "not":
      return !evaluate(node.node, values);
    case "and":
      return evaluate(node.left, values) && evaluate(node.right, values);
    case "or":
      return evaluate(node.left, values) || evaluate(node.right, values);
  }
}

export function keybindingWhenExpressionsOverlap(
  left: string | undefined,
  right: string | undefined,
): boolean {
  const normalizedLeft = left?.trim() ?? "";
  const normalizedRight = right?.trim() ?? "";
  const leftNode = normalizedLeft ? parseKeybindingWhenExpression(normalizedLeft) : undefined;
  const rightNode = normalizedRight ? parseKeybindingWhenExpression(normalizedRight) : undefined;
  if ((normalizedLeft && !leftNode) || (normalizedRight && !rightNode)) return true;
  const identifiers = new Set<string>();
  collectIdentifiers(leftNode ?? undefined, identifiers);
  collectIdentifiers(rightNode ?? undefined, identifiers);
  const names = [...identifiers];
  if (names.length > 12) return true;
  for (let combination = 0; combination < 2 ** names.length; combination += 1) {
    const values = new Map<string, boolean>();
    names.forEach((name, index) => values.set(name, Boolean(combination & (1 << index))));
    if (evaluate(leftNode ?? undefined, values) && evaluate(rightNode ?? undefined, values)) {
      return true;
    }
  }
  return false;
}
