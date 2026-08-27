import type { KeybindingWhenNode } from "@t3tools/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  parseKeybindingWhenExpression,
} from "@t3tools/shared/keybindings";
import { ChevronDownIcon, CircleXIcon, MinusIcon, PlusIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle } from "../ui/toggle";
import { cn } from "../../lib/utils";

type BooleanOperator = "and" | "or";

function expressionForNode(node: KeybindingWhenNode | undefined): string {
  if (!node) return "";
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${wrapExpression(node.node)}`;
    case "and":
      return `${wrapExpression(node.left)} && ${wrapExpression(node.right)}`;
    case "or":
      return `${wrapExpression(node.left)} || ${wrapExpression(node.right)}`;
  }
}

function wrapExpression(node: KeybindingWhenNode): string {
  return node.type === "and" || node.type === "or"
    ? `(${expressionForNode(node)})`
    : expressionForNode(node);
}

function collectIdentifiers(node: KeybindingWhenNode | undefined, into: Set<string>): void {
  if (!node) return;
  if (node.type === "identifier") {
    into.add(node.name);
    return;
  }
  if (node.type === "not") {
    collectIdentifiers(node.node, into);
    return;
  }
  collectIdentifiers(node.left, into);
  collectIdentifiers(node.right, into);
}

const KNOWN_WHEN_VARIABLES = (() => {
  const identifiers = new Set(["terminalFocus", "terminalOpen", "true", "false"]);
  for (const binding of DEFAULT_RESOLVED_KEYBINDINGS) {
    collectIdentifiers(binding.whenAst, identifiers);
  }
  return [...identifiers].toSorted();
})();

const DEFAULT_WHEN_VARIABLE =
  KNOWN_WHEN_VARIABLES.find((identifier) => identifier !== "true" && identifier !== "false") ??
  "terminalFocus";

function defaultCondition(): KeybindingWhenNode {
  return { type: "identifier", name: DEFAULT_WHEN_VARIABLE };
}

function conditionParts(
  node: KeybindingWhenNode,
): { readonly identifier: string; readonly negated: boolean } | null {
  if (node.type === "identifier") return { identifier: node.name, negated: false };
  if (node.type === "not" && node.node.type === "identifier") {
    return { identifier: node.node.name, negated: true };
  }
  return null;
}

function flattenChildren(
  node: KeybindingWhenNode,
  operator: BooleanOperator,
): KeybindingWhenNode[] {
  return node.type === operator
    ? [...flattenChildren(node.left, operator), ...flattenChildren(node.right, operator)]
    : [node];
}

function buildGroup(
  children: ReadonlyArray<KeybindingWhenNode>,
  operator: BooleanOperator,
): KeybindingWhenNode | undefined {
  const first = children[0];
  if (!first) return undefined;
  return children
    .slice(1)
    .reduce<KeybindingWhenNode>((left, right) => ({ type: operator, left, right }), first);
}

function VariableSelect(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const variables = KNOWN_WHEN_VARIABLES.includes(props.value)
    ? KNOWN_WHEN_VARIABLES
    : [props.value, ...KNOWN_WHEN_VARIABLES];
  return (
    <Select value={props.value} onValueChange={(value) => value && props.onChange(value)}>
      <SelectTrigger size="compact" className="min-w-0 flex-1 font-mono">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-72 min-w-44" matchTriggerWidth={false}>
        {variables.map((variable) => (
          <SelectItem className="font-mono text-xs" key={variable} value={variable}>
            {variable}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ExpressionNodeEditor(props: {
  readonly node: KeybindingWhenNode;
  readonly onChange: (node: KeybindingWhenNode) => void;
  readonly onRemove?: () => void;
}) {
  const condition = conditionParts(props.node);
  if (condition) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background/60 p-2">
        <Toggle
          pressed={condition.negated}
          onPressedChange={(negated) => {
            const identifier: KeybindingWhenNode = {
              type: "identifier",
              name: condition.identifier,
            };
            props.onChange(negated ? { type: "not", node: identifier } : identifier);
          }}
          aria-label={`Negate ${condition.identifier}`}
          size="sm"
          variant="outline"
        >
          Not
        </Toggle>
        <VariableSelect
          value={condition.identifier}
          onChange={(identifier) => {
            const next: KeybindingWhenNode = { type: "identifier", name: identifier };
            props.onChange(condition.negated ? { type: "not", node: next } : next);
          }}
        />
        {props.onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove condition"
            onClick={props.onRemove}
          >
            <MinusIcon />
          </Button>
        ) : null}
      </div>
    );
  }

  if (props.node.type === "not") {
    const notNode = props.node;
    return (
      <div className="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-2">
        <div className="flex items-center gap-2">
          <Toggle
            pressed
            onPressedChange={(pressed) => props.onChange(pressed ? notNode : notNode.node)}
            aria-label="Negate group"
            size="sm"
            variant="outline"
          >
            Not
          </Toggle>
          {props.onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label="Remove negated group"
              onClick={props.onRemove}
            >
              <MinusIcon />
            </Button>
          ) : null}
        </div>
        <ExpressionNodeEditor
          node={notNode.node}
          onChange={(node) => props.onChange({ type: "not", node })}
        />
      </div>
    );
  }

  const operator: BooleanOperator = props.node.type === "or" ? "or" : "and";
  const children = flattenChildren(props.node, operator);
  const updateChildren = (next: ReadonlyArray<KeybindingWhenNode>) => {
    const group = buildGroup(next, operator);
    if (group) props.onChange(group);
  };
  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={operator}
          onValueChange={(value) => {
            const next = buildGroup(children, value as BooleanOperator);
            if (next) props.onChange(next);
          }}
        >
          <SelectTrigger size="compact" className="w-24 font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="min-w-24" matchTriggerWidth={false}>
            <SelectItem value="and">and</SelectItem>
            <SelectItem value="or">or</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="compact"
          onClick={() => updateChildren([...children, defaultCondition()])}
        >
          <PlusIcon /> Condition
        </Button>
        <Button
          type="button"
          variant="outline"
          size="compact"
          onClick={() =>
            updateChildren([
              ...children,
              {
                type: operator === "and" ? "or" : "and",
                left: defaultCondition(),
                right: defaultCondition(),
              },
            ])
          }
        >
          <PlusIcon /> Group
        </Button>
        {props.onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Remove group"
            onClick={props.onRemove}
          >
            <MinusIcon />
          </Button>
        ) : null}
      </div>
      {children.map((child, index) => (
        <ExpressionNodeEditor
          key={`${expressionForNode(child)}:${index}`}
          node={child}
          onChange={(next) =>
            updateChildren(
              children.map((candidate, childIndex) => (childIndex === index ? next : candidate)),
            )
          }
          onRemove={() => {
            const next = children.filter((_, childIndex) => childIndex !== index);
            if (next.length === 1 && next[0]) props.onChange(next[0]);
            else updateChildren(next.length > 0 ? next : [defaultCondition()]);
          }}
        />
      ))}
    </div>
  );
}

export function KeybindingWhenEditor(props: {
  readonly value: string;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}) {
  const trimmed = props.value.trim();
  const parsed = trimmed ? parseKeybindingWhenExpression(trimmed) : undefined;
  const invalid = trimmed.length > 0 && !parsed;
  const updateNode = (node: KeybindingWhenNode | undefined) =>
    props.onChange(expressionForNode(node));

  return (
    <Popover>
      <PopoverTrigger
        disabled={props.disabled}
        className={cn(
          "inline-flex h-8 min-w-48 max-w-72 flex-1 items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left font-mono text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          !trimmed && "text-muted-foreground",
          invalid && "border-destructive text-destructive",
        )}
        aria-label="Edit when condition"
      >
        <span className="truncate">{trimmed || "Always"}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[min(34rem,calc(100vw-2rem))]">
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-sm font-medium">When</div>
            <Input
              nativeInput
              aria-label="When expression"
              aria-invalid={invalid}
              className="font-mono text-xs"
              placeholder="Always"
              value={props.value}
              onChange={(event) => props.onChange(event.currentTarget.value)}
            />
            {invalid ? (
              <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
                <CircleXIcon className="size-3.5" /> Use variables with !, &&, ||, and parentheses.
              </p>
            ) : null}
          </div>
          {parsed ? (
            <ExpressionNodeEditor
              node={parsed}
              onChange={updateNode}
              onRemove={() => updateNode(undefined)}
            />
          ) : invalid ? null : (
            <div className="flex gap-2 rounded-md border border-dashed p-3">
              <Button type="button" size="compact" onClick={() => updateNode(defaultCondition())}>
                <PlusIcon /> Condition
              </Button>
              <Button
                type="button"
                size="compact"
                variant="outline"
                onClick={() =>
                  updateNode({ type: "and", left: defaultCondition(), right: defaultCondition() })
                }
              >
                <PlusIcon /> Group
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
