// Ported from internal/provider/base.go

import type { Model } from "./types.ts";

/** BaseProvider provides common functionality for provider implementations. */
export class BaseProvider {
  private readonly providerName: string;
  private readonly providerModels: Model[];

  constructor(name: string, models: Model[]) {
    this.providerName = name;
    this.providerModels = models;
  }

  /** Returns the provider's name. */
  name(): string {
    return this.providerName;
  }

  /** Returns the list of available models. */
  models(): Model[] {
    return this.providerModels;
  }

  /** Returns a model by ID, or undefined if not found. */
  getModel(id: string): Model | undefined {
    return this.providerModels.find((m) => m.id === id);
  }
}
