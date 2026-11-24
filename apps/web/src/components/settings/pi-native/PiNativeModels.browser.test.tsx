import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import type {
  PiNativeModelBinding,
  PiNativeModelInfo,
} from "@t3tools/client-runtime/pi-native-catalog";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../../test/render";
import { PiNativeModelAdvancedSettings } from "./PiNativeModelAdvancedSettings";
import { PiNativeModelSelectionPanes } from "./PiNativeModelSelectionPanes";
import { PiNativeModelsPage } from "./PiNativeModelsPage";
import { PiNativeServiceChooser } from "./PiNativeServiceChooser";
import { PiNativeServiceDialog } from "./PiNativeServiceDialog";
import { listPiNativeServices, type PiNativeService } from "./piNativeModels.logic";

const environmentId = EnvironmentId.make("remote-device");

const serviceModels: PiNativeModelInfo[] = [
  {
    modelId: "alpha-text",
    displayName: "Alpha Text",
    reasoning: false,
    toolCall: true,
    attachment: false,
    inputModalities: ["text"],
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  {
    modelId: "beta-vision",
    displayName: "Beta Vision",
    reasoning: true,
    toolCall: true,
    attachment: true,
    inputModalities: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 16_384,
    supportedThinkingLevels: ["low", "high"],
  },
];

const state = vi.hoisted(() => ({
  settings: { providerInstances: {} } as {
    providerInstances: Record<string, ProviderInstanceConfig>;
  },
  probes: vi.fn(),
  lookups: vi.fn(),
  tests: vi.fn(),
  catalogStatus: vi.fn(),
  refreshCatalog: vi.fn(),
  refreshProviders: vi.fn(),
  persist: vi.fn(),
  updateSettings: vi.fn(),
  confirm: vi.fn<() => Promise<boolean>>(),
  toast: vi.fn(),
  scopeAllowed: true,
}));

const success = <T,>(value: T) => Promise.resolve({ _tag: "Success" as const, value });

vi.mock(import("../../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      piNativeProbeModels: { label: "probe" } as never,
      piNativeLookupModel: { label: "lookup" } as never,
      piNativeTestConnection: { label: "test" } as never,
      piNativeCatalogStatus: { label: "catalogStatus" } as never,
      piNativeRefreshCatalog: { label: "refreshCatalog" } as never,
      refreshProviders: { label: "refreshProviders" } as never,
    },
  };
});
vi.mock(import("../../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) => {
    switch (command.label) {
      case "probe":
        return state.probes;
      case "lookup":
        return state.lookups;
      case "test":
        return state.tests;
      case "catalogStatus":
        return state.catalogStatus;
      case "refreshCatalog":
        return state.refreshCatalog;
      case "refreshProviders":
        return state.refreshProviders;
      default:
        return vi.fn();
    }
  }) as never,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((_atom: unknown, selector?: (value: unknown) => unknown) =>
    selector === undefined ? [] : selector(null)) as never,
}));
vi.mock(import("../../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((_environmentId: string, selector?: (value: unknown) => unknown) =>
    selector === undefined ? state.settings : selector(state.settings)) as never,
  usePersistEnvironmentProviderInstanceMutation: (() => state.persist) as never,
  useUpdateEnvironmentSettings: (() => state.updateSettings) as never,
}));
vi.mock(import("../../../state/managedPolicy"), async (original) => ({
  ...(await original()),
  useManagedPolicy: (() => undefined) as never,
}));
vi.mock(import("../../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => state.scopeAllowed) as never,
  readEnvironmentScope: (() => state.scopeAllowed) as never,
}));
vi.mock(import("~/localApi"), async (original) => {
  const api = { dialogs: { confirm: state.confirm } };
  return {
    ...(await original()),
    readLocalApi: (() => api) as never,
    ensureLocalApi: (() => api) as never,
  };
});
vi.mock(import("../../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

function setup() {
  state.settings = { providerInstances: {} };
  state.scopeAllowed = true;
  state.probes.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      models: serviceModels,
      rawModels: [],
      effectiveBaseUrl: "https://api.example.com/v1",
      discoveryStyle: "openai_models",
    },
  });
  state.lookups.mockReset();
  state.tests.mockReset().mockImplementation(() =>
    success({
      ok: true,
      latencyMs: 12,
      effectiveBaseUrl: "https://api.example.com/v1",
      modelCount: 2,
    }),
  );
  state.catalogStatus.mockReset().mockImplementation(() =>
    success({
      loaded: true,
      source: "bundled",
      providerCount: 3,
      modelCount: 120,
    }),
  );
  state.refreshCatalog.mockReset().mockImplementation(() =>
    success({
      status: { loaded: true, source: "bundled", providerCount: 3, modelCount: 120 },
      updated: false,
    }),
  );
  state.refreshProviders.mockReset().mockImplementation(() => success({}));
  state.persist.mockReset().mockImplementation(() => success({}));
  state.updateSettings.mockReset();
  state.confirm.mockReset().mockResolvedValue(false);
  state.toast.mockReset();
}

function serviceFrom(instance: ProviderInstanceConfig): PiNativeService {
  const [service] = listPiNativeServices({
    [ProviderInstanceId.make("piNative_openai")]: instance,
  });
  if (service === undefined) throw new Error("The fixture service did not materialize.");
  return service;
}

const storedInstance = (
  overrides: Partial<ProviderInstanceConfig> = {},
  config: Record<string, unknown> = {},
): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make("piNative"),
  enabled: true,
  displayName: "Work OpenAI",
  config: {
    vendorKey: "openai",
    apiStyle: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-stored",
    defaultModel: "alpha-text",
    modelBindings: [
      {
        id: "alpha-text",
        contextWindow: 128_000,
        maxTokens: 8_192,
        thinkingLevels: [],
        defaultThinkingLevel: null,
      },
    ],
    sortOrder: 0,
    autoCompact: true,
    infiniteRetry: false,
    enableSubagents: true,
    customModels: [],
    ...config,
  },
  ...overrides,
});

const typedInput = (label: string) => page.getByRole("textbox", { name: label, exact: true });

describe("PiNativeServiceChooser", () => {
  it("filters presets by the search query and picks one", async () => {
    const onPickPreset = vi.fn();
    const onPickCustom = vi.fn();
    await using screen = await render(
      <PiNativeServiceChooser onPickCustom={onPickCustom} onPickPreset={onPickPreset} />,
      { router: false },
    );

    await userEvent.type(typedInput("Search services"), "gemini");
    await expect.element(screen.getByText("Google Gemini")).toBeVisible();
    expect(screen.getByText("OpenAI", { exact: true }).query()).toBeNull();

    await userEvent.click(screen.getByText("Google Gemini"));
    expect(onPickPreset).toHaveBeenCalledWith(
      expect.objectContaining({ id: "google", vendorKey: "google" }),
    );
    expect(onPickCustom).not.toHaveBeenCalled();
  });

  it("picks a custom endpoint from its tile", async () => {
    const onPickCustom = vi.fn();
    await using screen = await render(
      <PiNativeServiceChooser onPickCustom={onPickCustom} onPickPreset={vi.fn()} />,
      { router: false },
    );

    await userEvent.click(screen.getByText("Custom Endpoint"));
    expect(onPickCustom).toHaveBeenCalledOnce();
  });

  it("walks the tiles with the arrow keys and picks with Enter", async () => {
    const onPickPreset = vi.fn();
    await using _screen = await render(
      <PiNativeServiceChooser onPickCustom={vi.fn()} onPickPreset={onPickPreset} />,
      { router: false },
    );
    const search = typedInput("Search services");

    await userEvent.type(search, "open");
    await userEvent.keyboard("{Enter}");
    expect(onPickPreset).toHaveBeenCalledWith(expect.objectContaining({ id: "openai" }));

    // ArrowDown leaves the search for the first tile, ArrowRight moves to the next.
    await userEvent.click(search);
    await userEvent.keyboard("{ArrowDown}");
    const first = document.activeElement as HTMLElement;
    expect(first.textContent).toContain("OpenAI");
    await userEvent.keyboard("{ArrowRight}");
    const second = document.activeElement as HTMLElement;
    expect(second).not.toBe(first);
    await userEvent.keyboard("{Enter}");
    expect(onPickPreset).toHaveBeenCalledTimes(2);
  });
});

describe("PiNativeServiceDialog", () => {
  function dialog(props: {
    readonly mode:
      | { readonly kind: "create" }
      | { readonly kind: "edit"; readonly service: PiNativeService }
      | { readonly kind: "copy"; readonly source: PiNativeService };
    readonly existingInstanceIds?: ReadonlyArray<string>;
  }) {
    return (
      <PiNativeServiceDialog
        environmentId={environmentId}
        mode={props.mode}
        existingInstanceIds={props.existingInstanceIds ?? []}
        sortOrder={undefined}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
  }

  it("detects the wire style from a URL until the user picks one", async () => {
    setup();
    await using _screen = await render(dialog({ mode: { kind: "create" } }), { router: false });
    await userEvent.click(page.getByText("Custom Endpoint"));

    await userEvent.fill(typedInput("Base URL"), "https://api.anthropic.com");
    await expect
      .element(page.getByText("Detected Anthropic Messages from this URL."))
      .toBeVisible();
    // The trigger falls back to the raw value because the item list lives in a portal.
    await expect
      .element(page.getByRole("combobox", { name: "API style" }))
      .toHaveTextContent("anthropic-messages");

    await page.getByRole("combobox", { name: "API style" }).click();
    await page.getByRole("option", { name: "OpenAI Chat Completions" }).click();
    await userEvent.fill(
      typedInput("Base URL"),
      "https://generativelanguage.googleapis.com/v1beta",
    );
    // An explicit choice is never rewritten by a pasted URL.
    await expect
      .element(page.getByText("Detected Anthropic Messages from this URL."))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("combobox", { name: "API style" }))
      .toHaveTextContent("openai-completions");
  });

  it("keeps a copied service's API style locked against URL detection", async () => {
    setup();
    const source = serviceFrom(
      storedInstance({}, { apiStyle: "anthropic-messages", baseUrl: "https://api.anthropic.com" }),
    );
    await using _screen = await render(dialog({ mode: { kind: "copy", source } }), {
      router: false,
    });

    await userEvent.fill(typedInput("Base URL"), "https://api.openai.com/v1");
    await expect
      .element(page.getByRole("combobox", { name: "API style" }))
      .toHaveTextContent("anthropic-messages");
  });

  it("switches services from a custom endpoint and from a named preset", async () => {
    setup();
    await using _screen = await render(dialog({ mode: { kind: "create" } }), { router: false });
    await userEvent.click(page.getByText("Custom Endpoint"));
    await expect.element(page.getByText("Custom endpoint")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Change service" }));
    await expect.element(typedInput("Search services")).toBeVisible();

    await userEvent.click(page.getByText("Custom Endpoint"));
    await userEvent.click(page.getByRole("button", { name: "Change service" }));
    await userEvent.click(page.getByText("OpenAI", { exact: true }));
    await expect.element(page.getByText("OpenAI", { exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Change service" }));
    await expect.element(typedInput("Search services")).toBeVisible();
  });

  it("drops the saved credential from probe and test calls once cleared", async () => {
    setup();
    const service = serviceFrom(storedInstance());
    await using _screen = await render(dialog({ mode: { kind: "edit", service } }), {
      router: false,
    });

    await vi.waitFor(() => expect(state.probes.mock.calls.length).toBeGreaterThan(0));
    expect(state.probes.mock.calls.at(-1)?.[0].input).toMatchObject({
      instanceId: "piNative_openai",
    });
    expect(state.probes.mock.calls.at(-1)?.[0].input.apiKey).toBeUndefined();

    await userEvent.click(page.getByRole("button", { name: "Clear saved key" }));
    await vi.waitFor(() => expect(state.probes.mock.calls.length).toBeGreaterThan(1));
    expect(state.probes.mock.calls.at(-1)?.[0].input).not.toHaveProperty("instanceId");

    await userEvent.click(page.getByRole("button", { name: "Test connection" }));
    await vi.waitFor(() => expect(state.tests).toHaveBeenCalled());
    expect(state.tests.mock.calls.at(-1)?.[0].input).not.toHaveProperty("instanceId");
  });

  it("saves custom headers and the recommended models", async () => {
    setup();
    await using _screen = await render(dialog({ mode: { kind: "create" } }), { router: false });
    await userEvent.click(page.getByText("OpenAI", { exact: true }));
    // A named preset in create mode probes once a key is entered; drafts commit on blur.
    await userEvent.fill(typedInput("API key"), "sk-test");
    await userEvent.tab();
    await vi.waitFor(() => expect(state.probes).toHaveBeenCalled());

    await userEvent.click(page.getByRole("button", { name: "Advanced connection" }));
    await userEvent.click(page.getByRole("button", { name: "Add header" }));
    await userEvent.fill(typedInput("Header name"), "X-Tenant");
    await userEvent.fill(typedInput("Header value"), "acme");

    const save = page.getByRole("button", { name: "Save service" });
    await vi.waitFor(async () => expect(await save.element().hasAttribute("disabled")).toBe(false));
    await userEvent.click(save);

    await vi.waitFor(() => expect(state.persist).toHaveBeenCalled());
    const [{ operation, instanceId, instance }] = state.persist.mock.calls[0]!;
    expect(operation).toBe("upsert");
    expect(instanceId).toBe("piNative_openai");
    expect(instance).toMatchObject({
      driver: "piNative",
      enabled: true,
      displayName: "OpenAI",
      accentColor: "#10A37F",
    });
    expect(instance.config).toMatchObject({
      vendorKey: "openai",
      apiStyle: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      headers: { "X-Tenant": "acme" },
      apiKey: "sk-test",
    });
    expect(instance.config.modelBindings.length).toBeGreaterThan(0);
    expect(instance.config.defaultModel).toBe(instance.config.modelBindings[0]?.id);
  });
});

function PanesHarness(props: {
  readonly initial: ReadonlyArray<PiNativeModelBinding>;
  readonly models?: ReadonlyArray<PiNativeModelInfo>;
}) {
  const [models, setModels] = useState(props.initial);
  return (
    <div>
      <output data-testid="selected-ids">{models.map((entry) => entry.id).join(",")}</output>
      <PiNativeModelSelectionPanes
        environmentId={environmentId}
        instanceId={undefined}
        apiStyle="openai-responses"
        vendorKey="openai"
        baseUrl="https://api.example.com/v1"
        apiKey="sk-test"
        headers={{}}
        canProbe
        models={models}
        autoRecommend={false}
        onModelsChange={setModels}
        onAdoptBaseUrl={() => undefined}
      />
    </div>
  );
}

const selectedIds = () => document.querySelector('[data-testid="selected-ids"]')?.textContent ?? "";

describe("PiNativeModelSelectionPanes", () => {
  it("probes the endpoint and filters the result by capability", async () => {
    setup();
    await using screen = await render(<PanesHarness initial={[]} />, { router: false });

    await expect.element(screen.getByText("Beta Vision")).toBeVisible();
    expect(state.probes).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Show only Vision models" }));
    await expect.element(screen.getByText("Beta Vision")).toBeVisible();
    expect(screen.getByText("Alpha Text").query()).toBeNull();
  });

  it("selects, clears and reorders the chosen models", async () => {
    setup();
    await using screen = await render(<PanesHarness initial={[]} />, { router: false });
    await expect.element(screen.getByText("Alpha Text")).toBeVisible();

    await userEvent.click(screen.getByText("Alpha Text"));
    expect(selectedIds()).toBe("alpha-text");

    await userEvent.click(screen.getByRole("button", { name: "Select visible" }));
    expect(selectedIds()).toBe("alpha-text,beta-vision");

    await userEvent.click(screen.getByRole("button", { name: "Move alpha-text down" }));
    expect(selectedIds()).toBe("beta-vision,alpha-text");
    await userEvent.click(screen.getByRole("button", { name: "Move alpha-text up" }));
    expect(selectedIds()).toBe("alpha-text,beta-vision");

    await userEvent.click(screen.getByRole("button", { name: "Clear visible" }));
    expect(selectedIds()).toBe("");
  });

  it("keeps edits made while a custom model lookup is still in flight", async () => {
    setup();
    let resolveLookup!: (value: unknown) => void;
    state.lookups.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    await using screen = await render(<PanesHarness initial={[]} />, { router: false });
    await expect.element(screen.getByText("Alpha Text")).toBeVisible();

    await userEvent.fill(typedInput("Add model ID"), "acme-custom");
    await userEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
    expect(selectedIds()).toBe("acme-custom");

    // Adding a model opens its advanced panel.
    await userEvent.fill(typedInput("Model alias"), "Acme alias");
    await userEvent.fill(typedInput("Context window tokens"), "64000");

    await act(async () =>
      resolveLookup({
        _tag: "Success",
        value: {
          model: {
            modelId: "acme-custom",
            displayName: "Acme Custom",
            reasoning: true,
            toolCall: true,
            attachment: true,
            inputModalities: ["text", "image"],
            contextWindow: 400_000,
            maxTokens: 32_768,
            supportedThinkingLevels: ["low", "medium"],
          },
        },
      }),
    );

    // The alias and the pinned limit survive; untouched fields adopt the lookup.
    await expect.element(typedInput("Model alias")).toHaveValue("Acme alias");
    await expect.element(typedInput("Context window tokens")).toHaveValue("64000");
    await expect.element(typedInput("Maximum output tokens")).toHaveValue("32768");
  });
});

function AdvancedHarness(props: { readonly initial: PiNativeModelBinding }) {
  const [binding, setBinding] = useState(props.initial);
  return (
    <div>
      <output data-testid="binding">{JSON.stringify(binding)}</output>
      <PiNativeModelAdvancedSettings
        id="advanced"
        binding={binding}
        info={undefined}
        apiStyle="openai-completions"
        onChange={(update) => setBinding((current) => ({ ...current, ...update }))}
      />
    </div>
  );
}

const currentBinding = () =>
  JSON.parse(document.querySelector('[data-testid="binding"]')?.textContent ?? "{}") as Record<
    string,
    unknown
  >;

describe("PiNativeModelAdvancedSettings", () => {
  it("leaves subagent opt-in unchecked until it is set", async () => {
    setup();
    await using screen = await render(
      <AdvancedHarness
        initial={{
          id: "alpha-text",
          contextWindow: 128_000,
          contextWindowSource: "catalog",
          maxTokens: 8_192,
          maxTokensSource: "catalog",
          thinkingLevels: [],
          defaultThinkingLevel: null,
        }}
      />,
      { router: false },
    );
    const checkbox = screen.getByRole("checkbox", { name: "Available for subagents" });
    await expect.element(checkbox).not.toBeChecked();

    await userEvent.click(checkbox);
    expect(currentBinding().availableForSubagents).toBe(true);
  });

  it("promotes a default thinking level when the first level is enabled", async () => {
    setup();
    await using screen = await render(
      <AdvancedHarness
        initial={{
          id: "alpha-text",
          contextWindow: 128_000,
          maxTokens: 8_192,
          thinkingLevels: [],
          defaultThinkingLevel: null,
        }}
      />,
      { router: false },
    );

    await userEvent.click(screen.getByRole("button", { name: "Thinking level low" }));
    expect(currentBinding()).toMatchObject({
      thinkingLevels: ["low"],
      defaultThinkingLevel: "low",
    });

    // Disabling the only level clears the default again.
    await userEvent.click(screen.getByRole("button", { name: "Thinking level low" }));
    expect(currentBinding()).toMatchObject({ thinkingLevels: [], defaultThinkingLevel: null });
  });

  it("switches limit provenance from catalog to user on edit", async () => {
    setup();
    await using screen = await render(
      <AdvancedHarness
        initial={{
          id: "alpha-text",
          contextWindow: 128_000,
          contextWindowSource: "catalog",
          maxTokens: 8_192,
          maxTokensSource: "catalog",
          thinkingLevels: [],
          defaultThinkingLevel: null,
        }}
      />,
      { router: false },
    );
    expect(screen.getByText("Catalog", { exact: true }).first().query()).not.toBeNull();

    await userEvent.fill(typedInput("Context window tokens"), "64000");
    expect(currentBinding()).toMatchObject({
      contextWindow: 64_000,
      contextWindowSource: "user",
      maxTokensSource: "catalog",
    });

    await userEvent.fill(typedInput("Maximum output tokens"), "32000");
    expect(currentBinding()).toMatchObject({
      maxTokens: 32_000,
      maxTokensSource: "user",
    });
    await expect.element(screen.getByText("User", { exact: true }).first()).toBeVisible();
    expect(screen.getByText("Catalog", { exact: true }).query()).toBeNull();
  });
});

describe("PiNativeModelsPage", () => {
  function page_() {
    return <PiNativeModelsPage environmentId={environmentId} />;
  }

  it("renders the stored services with the API style they really use", async () => {
    setup();
    state.settings = {
      providerInstances: {
        piNative_openai: storedInstance(
          {},
          {
            vendorKey: "opencode-go",
            apiStyle: "openai-completions",
            headers: { "X-Tenant": "acme" },
            defaultModel: "alpha-text",
            modelBindings: [
              {
                id: "alpha-text",
                contextWindow: 128_000,
                maxTokens: 8_192,
                thinkingLevels: [],
                defaultThinkingLevel: null,
              },
              {
                id: "beta-vision",
                contextWindow: 200_000,
                maxTokens: 16_384,
                thinkingLevels: [],
                defaultThinkingLevel: null,
              },
            ],
          },
        ),
        piNative_second: storedInstance({ displayName: "Second row" }, { sortOrder: 1 }),
      },
    };
    await using screen = await render(page_());

    await expect.element(screen.getByText("Work OpenAI")).toBeVisible();
    // The row reports the stored style, not a sibling preset that shares the vendor key.
    await expect.element(screen.getByText("OpenAI Chat Completions")).toBeVisible();
    expect(screen.getByText("OpenCode Go", { exact: true }).query()).toBeNull();
    expect(screen.getByText(/2 models/u).query()).not.toBeNull();
  });

  it("forwards saved headers when testing a row and toggles, copies and deletes", async () => {
    setup();
    state.settings = {
      providerInstances: {
        piNative_openai: storedInstance({}, { headers: { "X-Tenant": "acme" } }),
      },
    };
    await using screen = await render(page_());

    await userEvent.click(await screen.getByRole("button", { name: "Test Work OpenAI" }));
    await vi.waitFor(() => expect(state.tests).toHaveBeenCalled());
    expect(state.tests.mock.calls.at(-1)?.[0].input).toMatchObject({
      apiStyle: "openai-responses",
      instanceId: "piNative_openai",
      headers: { "X-Tenant": "acme" },
    });

    await userEvent.click(page.getByRole("switch", { name: "Enable Work OpenAI" }));
    await vi.waitFor(() => expect(state.persist).toHaveBeenCalled());
    expect(state.persist.mock.calls.at(-1)?.[0]).toMatchObject({ operation: "upsert" });

    await userEvent.click(page.getByRole("button", { name: "Copy Work OpenAI" }));
    await expect.element(page.getByText("Copy Pi Native service")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));

    state.confirm.mockResolvedValue(true);
    await userEvent.click(page.getByRole("button", { name: "Delete Work OpenAI" }));
    await vi.waitFor(() =>
      expect(state.persist).toHaveBeenCalledWith({
        operation: "remove",
        instanceId: "piNative_openai",
      }),
    );
  });
});
