"use client";

import { ArrowDownIcon, ArrowUpIcon, EyeIcon, EyeOffIcon, InfoIcon, StarIcon } from "lucide-react";
import { useMemo } from "react";
import type { ProviderInstanceId, ServerProviderModel } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { sortModelsForProviderInstance } from "../../modelOrdering";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ProviderModelsSectionProps {
  readonly instanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
}

export function ProviderModelsSection({
  instanceId,
  models,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
}: ProviderModelsSectionProps) {
  const hiddenModelSet = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const favoriteModelSet = useMemo(() => new Set(favoriteModels), [favoriteModels]);
  const builtInModels = useMemo(() => models.filter((model) => !model.isCustom), [models]);
  const orderedModels = useMemo(() => {
    return sortModelsForProviderInstance(builtInModels, {
      favoriteModels: favoriteModelSet,
      groupFavorites: true,
      modelOrder,
    });
  }, [builtInModels, favoriteModelSet, modelOrder]);

  const handleToggleHidden = (slug: string) => {
    if (hiddenModelSet.has(slug)) {
      onHiddenModelsChange(hiddenModels.filter((model) => model !== slug));
      return;
    }
    onHiddenModelsChange([...hiddenModels, slug]);
  };

  const handleToggleFavorite = (slug: string) => {
    if (favoriteModelSet.has(slug)) {
      onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
      return;
    }
    onFavoriteModelsChange([...favoriteModels, slug]);
  };

  const handleMove = (slug: string, direction: -1 | 1) => {
    const slugs = orderedModels.map((model) => model.slug);
    const index = slugs.indexOf(slug);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= slugs.length) return;
    const next = [...slugs];
    [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
    onModelOrderChange(next);
  };

  return (
    <div className="lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      <div className="text-xs font-medium text-foreground">Models</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {builtInModels.length} model{builtInModels.length === 1 ? "" : "s"} available.
      </div>
      <div className="mt-2 max-h-40 overflow-y-auto pb-1 lg:min-h-0 lg:max-h-none lg:flex-1">
        {orderedModels.map((model, index) => {
          const caps = model.capabilities;
          const capLabels: string[] = [];
          const isHidden = hiddenModelSet.has(model.slug);
          const isFavorite = favoriteModelSet.has(model.slug);
          const previousModel = orderedModels[index - 1];
          const nextModel = orderedModels[index + 1];
          const canMoveUp =
            previousModel !== undefined && favoriteModelSet.has(previousModel.slug) === isFavorite;
          const canMoveDown =
            nextModel !== undefined && favoriteModelSet.has(nextModel.slug) === isFavorite;
          const descriptors = caps?.optionDescriptors ?? [];
          if (descriptors.some((descriptor) => descriptor.id === "fastMode")) {
            capLabels.push("Fast mode");
          }
          if (descriptors.some((descriptor) => descriptor.id === "thinking")) {
            capLabels.push("Thinking");
          }
          if (
            descriptors.some(
              (descriptor) =>
                descriptor.type === "select" &&
                (descriptor.id === "reasoningEffort" ||
                  descriptor.id === "effort" ||
                  descriptor.id === "reasoning" ||
                  descriptor.id === "variant"),
            )
          ) {
            capLabels.push("Reasoning");
          }
          const hasDetails = capLabels.length > 0 || model.name !== model.slug;

          return (
            <div
              key={`${instanceId}:${model.slug}`}
              className={cn(
                "grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-1",
                isHidden && "text-muted-foreground",
              )}
            >
              <div className="flex min-w-0 items-center gap-1">
                <span
                  className={cn(
                    "min-w-0 truncate text-xs",
                    isHidden ? "text-muted-foreground line-through" : "text-foreground/90",
                  )}
                >
                  {model.name}
                </span>
                {hasDetails ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-micro"
                          variant="ghost"
                          className="text-muted-foreground/60 hover:text-muted-foreground"
                          aria-label={`Details for ${model.name}`}
                        />
                      }
                    >
                      <InfoIcon className="size-3" />
                    </TooltipTrigger>
                    <TooltipPopup side="top" className="max-w-56">
                      <div className="space-y-1">
                        <code className="block text-[11px] text-foreground">{model.slug}</code>
                        {capLabels.length > 0 ? (
                          <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                            {capLabels.map((label) => (
                              <span key={label} className="text-[10px] text-muted-foreground">
                                {label}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </TooltipPopup>
                  </Tooltip>
                ) : null}
                {isHidden ? (
                  <span className="text-[10px] text-muted-foreground">hidden</span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost-muted"
                        className={cn(isFavorite && "text-yellow-500 hover:text-yellow-600")}
                        onClick={() => handleToggleFavorite(model.slug)}
                        aria-label={`${isFavorite ? "Remove" : "Add"} ${model.name} ${
                          isFavorite ? "from" : "to"
                        } favorites`}
                      />
                    }
                  >
                    <StarIcon className={cn("size-3", isFavorite && "fill-current")} />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    {isFavorite ? "Remove from favorites" : "Add to favorites"}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost-muted"
                        disabled={!canMoveUp}
                        onClick={() => handleMove(model.slug, -1)}
                        aria-label={`Move ${model.name} up`}
                      />
                    }
                  >
                    <ArrowUpIcon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Move up</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost-muted"
                        disabled={!canMoveDown}
                        onClick={() => handleMove(model.slug, 1)}
                        aria-label={`Move ${model.name} down`}
                      />
                    }
                  >
                    <ArrowDownIcon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Move down</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-micro"
                        variant="ghost-muted"
                        onClick={() => handleToggleHidden(model.slug)}
                        aria-label={`${isHidden ? "Show" : "Hide"} ${model.name}`}
                      />
                    }
                  >
                    {isHidden ? <EyeIcon className="size-3" /> : <EyeOffIcon className="size-3" />}
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    {isHidden ? "Show in picker" : "Hide from picker"}
                  </TooltipPopup>
                </Tooltip>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
