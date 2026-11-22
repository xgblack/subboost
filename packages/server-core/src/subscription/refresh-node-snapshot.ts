import { parseSubscription } from "@subboost/core/parser";
import { normalizeNodeOrderMetadata } from "@subboost/core/subscription/node-order";
import { stripImportedNodeControlFields } from "@subboost/core/subscription/imported-node-controls";
import {
  getNodeSourceIds,
  keepOnlyValidNodeSourceIds,
  normalizeNodeOriginName,
} from "@subboost/core/subscription/node-source-state";
import {
  detachSourceNodesFromState,
  type DeletedNodeDescriptor,
  mergeParsedSourceNodes,
  prepareSourceParsedNodes,
} from "@subboost/core/subscription/source-node-refresh";
import {
  hasSubscriptionUserInfo,
  mergeSubscriptionUserInfo,
  normalizeSubscriptionUserInfo,
  parseSubscriptionUserInfo,
  resolveSubscriptionUserInfo,
  type SubscriptionUserInfo,
} from "@subboost/core/subscription/subscription-userinfo";
import {
  pickSubscriptionResponseInfoFromHeaders,
  type SubscriptionResponseInfo,
} from "@subboost/core/subscription/subscription-response-info";
import { isSubscriptionImportError, type SubscriptionImportErrorCategory } from "@subboost/core/subscription/import-error";
import type { ParsedNode } from "@subboost/core/types/node";
import { composeNodeNameRenameMaps } from "@subboost/core/subscription/node-name-references";
import { normalizeSavedSourcesForPersistence, type SavedSource, type SavedSourceType } from "./saved-sources";

type UrlNodeFetchResult = {
  ok: boolean;
  nodes: ParsedNode[];
  errors?: string[];
  warnings?: string[];
  headers?: Record<string, string>;
  error?: string;
  errorInfo?: {
    category?: SubscriptionImportErrorCategory;
    message?: string;
    detail?: string;
    httpStatus?: number;
  } | null;
  publicReason?: string | null;
  responseStatus?: number;
};

export type RefreshNodeSnapshotFailedSource = {
  id: string;
  type: SavedSourceType;
  content: string;
  errorMessage: string;
  errorCategory?: SubscriptionImportErrorCategory;
  httpStatus?: number;
  publicReason?: string | null;
};

export type RefreshNodeSnapshotOptions = {
  config: Record<string, unknown>;
  urls: string[];
  storedNodes: ParsedNode[];
  /** Restrict execution, while retaining the full source list for ownership and metadata. */
  targetSourceId?: string;
  signal?: AbortSignal;
  fetchUrlNodes: (source: SavedSource) => Promise<UrlNodeFetchResult>;
  fetchUrlUserInfo?: (source: SavedSource) => Promise<Record<string, string> | undefined>;
};

export type RefreshNodeSnapshotSourceResult = {
  sourceId: string;
  type: SavedSourceType;
  startedAt: Date;
  completedAt: Date;
  outcome: "refreshed" | "failed";
  nodeCountBefore: number;
  nodeCountAfter: number;
  nodesChanged: boolean;
  durationMs: number;
  warningCount: number;
  errorCategory?: SubscriptionImportErrorCategory;
  httpStatus?: number;
};

export type RefreshNodeSnapshotResult = {
  sourceResults?: RefreshNodeSnapshotSourceResult[];
  nodes: ParsedNode[];
  renameMap?: ReadonlyMap<string, string>;
  subscriptionInfo: SubscriptionResponseInfo;
  savedSources: SavedSource[];
  attemptedUrlFetch: boolean;
  usedUrlFetch: boolean;
  refreshableSourceCount: number;
  refreshedSourceCount: number;
  refreshedUrlSourceCount: number;
  refreshedStaticSourceCount: number;
  detachedSourceCount: number;
  failedSourceCount: number;
  failedSources: RefreshNodeSnapshotFailedSource[];
};

function getDeletedNodeNames(config: Record<string, unknown>): string[] {
  if (!Array.isArray(config.deletedNodeNames)) return [];
  return (config.deletedNodeNames as unknown[])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getDeletedNodes(config: Record<string, unknown>): DeletedNodeDescriptor[] {
  if (!Array.isArray(config.deletedNodes)) return [];
  return (config.deletedNodes as unknown[]).filter(
    (item): item is DeletedNodeDescriptor => Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
}

export function resolveSmartNodeMatchingEnabled(config: Record<string, unknown>): boolean {
  return config.smartNodeMatchingEnabled !== false;
}

type StableMetadataState = {
  value?: string;
  conflicted: boolean;
};

function mergeStableMetadataValue(state: StableMetadataState, nextValue: string | undefined) {
  if (!nextValue || state.conflicted) return;
  if (!state.value) {
    state.value = nextValue;
    return;
  }
  if (state.value !== nextValue) {
    state.value = undefined;
    state.conflicted = true;
  }
}

export async function refreshNodeSnapshot(
  options: RefreshNodeSnapshotOptions
): Promise<RefreshNodeSnapshotResult> {
  options.signal?.throwIfAborted();
  const savedSources = normalizeSavedSourcesForPersistence(options.config.sources, {
    fallbackUrls: options.urls,
  });
  if (options.targetSourceId && !savedSources.some((source) => source.id === options.targetSourceId)) {
    throw new Error("Import source not found.");
  }
  const selected = (source: SavedSource) => !options.targetSourceId || source.id === options.targetSourceId;
  let refreshedSavedSources = savedSources.map((source) => ({ ...source }));
  const validSourceIds = new Set(savedSources.map((source) => source.id));
  const deletedNodeNames = getDeletedNodeNames(options.config);
  const deletedNodes = getDeletedNodes(options.config);
  const smartNodeMatchingEnabled = resolveSmartNodeMatchingEnabled(options.config);

  let currentNodes = options.storedNodes
    .map(stripImportedNodeControlFields)
    .map(normalizeNodeOriginName)
    .map((node) => keepOnlyValidNodeSourceIds(node, validSourceIds))
    .filter(Boolean) as ParsedNode[];
  currentNodes = normalizeNodeOrderMetadata(currentNodes);

  const subscriptionInfo: SubscriptionResponseInfo = {};
  const profileWebPageUrlState: StableMetadataState = { conflicted: false };
  const planNameState: StableMetadataState = { conflicted: false };
  const attemptedUrlFetch = savedSources.some((source) => selected(source) && source.type === "url" && !source.useProxyProviders);
  let usedUrlFetch = false;
  let refreshableSourceCount = 0;
  let refreshedSourceCount = 0;
  let refreshedUrlSourceCount = 0;
  let refreshedStaticSourceCount = 0;
  let detachedSourceCount = 0;
  let failedSourceCount = 0;
  const failedSources: RefreshNodeSnapshotFailedSource[] = [];
  const sourceResults: RefreshNodeSnapshotSourceResult[] = [];
  const resultBySource = new Map<string, RefreshNodeSnapshotSourceResult>();
  let renameMap = new Map<string, string>();

  const recordFailedSource = (
    source: SavedSource,
    errorMessage: string,
    extra: {
      errorCategory?: SubscriptionImportErrorCategory;
      httpStatus?: number;
      publicReason?: string | null;
    } = {}
  ) => {
    failedSourceCount += 1;
    const result = resultBySource.get(source.id);
    if (result) {
      result.outcome = "failed";
      result.errorCategory = extra.errorCategory;
      result.httpStatus = extra.httpStatus;
    }
    failedSources.push({
      id: source.id,
      type: source.type,
      content: source.content,
      errorMessage,
      ...extra,
    });
  };

  const mergeResponseMetadata = (headers?: Record<string, string>) => {
    const responseInfo = pickSubscriptionResponseInfoFromHeaders(headers);
    mergeStableMetadataValue(profileWebPageUrlState, responseInfo.profileWebPageUrl);
    mergeStableMetadataValue(planNameState, responseInfo.planName);
  };

  const updateSourceSubscriptionInfo = (sourceId: string, info: SubscriptionUserInfo | undefined) => {
    const index = refreshedSavedSources.findIndex((source) => source.id === sourceId);
    if (index < 0) return;

    const normalized = normalizeSubscriptionUserInfo(info);
    if (hasSubscriptionUserInfo(normalized)) {
      refreshedSavedSources = refreshedSavedSources.map((source, i) =>
        i === index ? { ...source, subscriptionUserInfo: normalized } : source
      );
    }
  };

  const shouldFetchSupplementalUserInfoForSource = (source: SavedSource): boolean => {
    return Boolean(source.userinfoUrl || source.userinfoUserAgent);
  };

  const expectedFetchError = (error: unknown): string | null => {
    if (isSubscriptionImportError(error)) return error.info.message;
    if (!(error instanceof Error)) return null;
    if (error.name === "AbortError" || error.name === "TimeoutError") return "订阅源请求超时";
    const code = (error as Error & { code?: string; cause?: { code?: string } }).code
      ?? (error as Error & { cause?: { code?: string } }).cause?.code;
    return typeof code === "string" && /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(code)
      ? `订阅源请求失败 ${code}` : null;
  };

  const fetchSupplementalInfo = async (source: SavedSource) => {
    options.signal?.throwIfAborted();
    const startedAt = Date.now();
    const result = resultBySource.get(source.id);
    try {
      const headers = await options.fetchUrlUserInfo?.(source);
      options.signal?.throwIfAborted();
      if (result && shouldFetchSupplementalUserInfoForSource(source) && !headers?.["subscription-userinfo"]) result.warningCount += 1;
      return headers;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!expectedFetchError(error)) throw error;
      if (result) result.warningCount += 1;
      return undefined;
    } finally {
      if (result) {
        result.completedAt = new Date();
        result.durationMs += Date.now() - startedAt;
      }
    }
  };

  for (const source of savedSources) {
    options.signal?.throwIfAborted();
    if (!selected(source)) continue;
    if (source.type === "url" && source.useProxyProviders) {
      const detached = detachSourceNodesFromState(currentNodes, source.id);
      if (detached.nodes.length !== currentNodes.length) {
        detachedSourceCount += 1;
        refreshedSourceCount += 1;
      }
      currentNodes = detached.nodes;
      if (
        typeof options.fetchUrlUserInfo === "function" &&
        shouldFetchSupplementalUserInfoForSource(source)
      ) {
        const headers = await fetchSupplementalInfo(source);
        if (headers) {
          mergeResponseMetadata(headers);
          const header = headers["subscription-userinfo"];
          updateSourceSubscriptionInfo(
            source.id,
            header ? resolveSubscriptionUserInfo(parseSubscriptionUserInfo(header)) : undefined
          );
        }
      }
      continue;
    }

    refreshableSourceCount += 1;
    const result: RefreshNodeSnapshotSourceResult = {
      sourceId: source.id, type: source.type,
      startedAt: new Date(), completedAt: new Date(), outcome: "refreshed",
      nodeCountBefore: 0, nodeCountAfter: 0, nodesChanged: false, durationMs: 0, warningCount: 0,
    };
    sourceResults.push(result);
    resultBySource.set(source.id, result);
    try {
      if (source.type === "url") {
        let fetched: UrlNodeFetchResult;
        try {
          fetched = await options.fetchUrlNodes(source);
          options.signal?.throwIfAborted();
        } catch (error) {
          options.signal?.throwIfAborted();
          const message = expectedFetchError(error);
          if (!message) throw error;
          recordFailedSource(source, message, { errorCategory: "network" });
          continue;
        }
        result.warningCount += (fetched.errors?.length ?? 0) + (fetched.warnings?.length ?? 0);
        mergeResponseMetadata(fetched.headers);
        const userInfoHeader = fetched.headers?.["subscription-userinfo"];
        const rawUserInfo = userInfoHeader ? parseSubscriptionUserInfo(userInfoHeader) : undefined;
        const resolvedUserInfo = resolveSubscriptionUserInfo(
          rawUserInfo,
          fetched.ok ? fetched.nodes : []
        );
        if (!fetched.ok || fetched.nodes.length === 0) {
          const errorInfo = fetched.errorInfo ?? null;
          const firstParseError =
            Array.isArray(fetched.errors) && typeof fetched.errors[0] === "string"
              ? fetched.errors[0]
              : null;
          const errorMessage =
            errorInfo?.detail ||
            errorInfo?.message ||
            fetched.error ||
            firstParseError ||
            "未解析到可用节点";
          recordFailedSource(source, errorMessage, {
            errorCategory: errorInfo?.category ?? (firstParseError ? "parse" : undefined),
            httpStatus: errorInfo?.httpStatus ?? fetched.responseStatus,
            publicReason: fetched.publicReason ?? null,
          });
          continue;
        }
        updateSourceSubscriptionInfo(source.id, resolvedUserInfo);

        const parsedNodes = prepareSourceParsedNodes(fetched.nodes, {
          currentTag: source.tag,
          currentNameTemplate: source.nameTemplate,
        });
        const merged = mergeParsedSourceNodes(currentNodes, parsedNodes, deletedNodeNames, {
          sourceId: source.id,
          currentTag: source.tag,
          currentNameTemplate: source.nameTemplate,
          lastTag: source.lastParsedTag,
          lastNameTemplate: source.lastParsedNameTemplate,
          treatAsNewSource: Boolean(
            source.lastParsedContent &&
              source.lastParsedContent.trim() &&
              source.lastParsedContent.trim() !== source.content.trim()
          ),
          smartNodeMatchingEnabled,
          deletedNodes,
        });

        renameMap = composeNodeNameRenameMaps(renameMap, merged.renameMap);
        currentNodes = merged.nodes;
        usedUrlFetch = true;
        refreshedSourceCount += 1;
        refreshedUrlSourceCount += 1;
        continue;
      }

      let parsed: ReturnType<typeof parseSubscription>;
      try {
        parsed = parseSubscription(source.content);
      } catch (error) {
        recordFailedSource(source, error instanceof Error ? error.message : "解析失败", { errorCategory: "parse" });
        continue;
      }
      const resolvedUserInfo = resolveSubscriptionUserInfo(undefined, parsed.nodes);
      result.warningCount += parsed.errors?.length ?? 0;
      if (parsed.nodes.length === 0) {
        recordFailedSource(source, "未解析到可用节点", { errorCategory: "parse" });
        continue;
      }
      updateSourceSubscriptionInfo(source.id, resolvedUserInfo);

      const parsedNodes = prepareSourceParsedNodes(parsed.nodes, {
        currentTag: source.tag,
        currentNameTemplate: source.nameTemplate,
      });
      const merged = mergeParsedSourceNodes(currentNodes, parsedNodes, deletedNodeNames, {
        sourceId: source.id,
        currentTag: source.tag,
        currentNameTemplate: source.nameTemplate,
        lastTag: source.lastParsedTag,
        lastNameTemplate: source.lastParsedNameTemplate,
        treatAsNewSource: false,
        smartNodeMatchingEnabled,
        deletedNodes,
      });

      renameMap = composeNodeNameRenameMaps(renameMap, merged.renameMap);
      currentNodes = merged.nodes;
      refreshedSourceCount += 1;
      refreshedStaticSourceCount += 1;
    } finally {
      result.completedAt = new Date();
      result.durationMs += result.completedAt.getTime() - result.startedAt.getTime();
    }
  }

  if (
    typeof options.fetchUrlUserInfo === "function" &&
    usedUrlFetch &&
    (
      !refreshedSavedSources.some((source) => hasSubscriptionUserInfo(source.subscriptionUserInfo)) ||
      savedSources.some((source) => selected(source) && source.type === "url" && shouldFetchSupplementalUserInfoForSource(source))
    )
  ) {
    for (const source of savedSources) {
      if (!selected(source) || source.type !== "url" || source.useProxyProviders) continue;
      if (resultBySource.get(source.id)?.outcome === "failed") continue;
      if (!shouldFetchSupplementalUserInfoForSource(source) && refreshedSavedSources.some((item) => hasSubscriptionUserInfo(item.subscriptionUserInfo))) continue;
      const headers = await fetchSupplementalInfo(source);
      if (!headers) continue;
      mergeResponseMetadata(headers);
      const header = headers["subscription-userinfo"];
      updateSourceSubscriptionInfo(
        source.id,
        header ? resolveSubscriptionUserInfo(parseSubscriptionUserInfo(header)) : undefined
      );
    }
  }

  // Sum each saved snapshot once, including failed and unselected sources.
  for (const source of refreshedSavedSources) {
    if (hasSubscriptionUserInfo(source.subscriptionUserInfo)) {
      mergeSubscriptionUserInfo(subscriptionInfo, source.subscriptionUserInfo!);
    }
  }
  options.signal?.throwIfAborted();
  const sourceNodes = (nodes: ParsedNode[], sourceId: string) => nodes.filter((node) => getNodeSourceIds(node).includes(sourceId));
  const serializeNodes = (nodes: ParsedNode[]) => JSON.stringify(nodes, (key, value) => {
    if (key.startsWith("_")) return undefined;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map((name) => [name, value[name]]));
    }
    return value;
  });
  for (const result of sourceResults) {
    const before = sourceNodes(options.storedNodes, result.sourceId);
    const after = sourceNodes(currentNodes, result.sourceId);
    result.nodeCountBefore = before.length;
    result.nodeCountAfter = after.length;
    result.nodesChanged = serializeNodes(before) !== serializeNodes(after);
  }

  if (!profileWebPageUrlState.conflicted && profileWebPageUrlState.value) {
    subscriptionInfo.profileWebPageUrl = profileWebPageUrlState.value;
  }
  if (!planNameState.conflicted && planNameState.value) {
    subscriptionInfo.planName = planNameState.value;
  }

  return {
    sourceResults,
    nodes: currentNodes,
    renameMap,
    subscriptionInfo,
    savedSources: refreshedSavedSources,
    attemptedUrlFetch,
    usedUrlFetch,
    refreshableSourceCount,
    refreshedSourceCount,
    refreshedUrlSourceCount,
    refreshedStaticSourceCount,
    detachedSourceCount,
    failedSourceCount,
    failedSources,
  };
}
