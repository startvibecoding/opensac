// Public surface of src/skillhub (ported from internal/skillhub).

export {
  cloneCategories,
  cloneSearchPage,
  cloneSkillDetail,
  createMemoryCache,
  MemoryCache,
} from "./cache.ts";
export {
  boundedLimit,
  download,
  endpoint,
  filterSkills,
} from "./client_helpers.ts";
export {
  ambiguousSkillSlugCode,
  ClawHubClient,
  clawHubDefaultURL,
  clawHubItemSummary,
  clawSkillRef,
  createClawHubClient,
  maxClawContentBytes,
  maxClawJSONBytes,
  parseClawAmbiguity,
  parseClawHubDetail,
  parseClawHubItem,
  parseClawHubSearchItem,
  parseTags,
  parseTimestamp,
  parseVersion,
  skillPath,
} from "./clawhub.ts";
export { clientsForSettings, httpClientWithToken } from "./factory.ts";
export {
  createHTTPClient,
  decodeJSON,
  defaultHttpClient,
  defaultMaxJSONBytes,
  defaultRequestTimeout,
  endpoint as buildEndpoint,
  errBodyBytes,
  getJSON,
  getWithStatus,
  type HttpClient,
  statusText,
} from "./http.ts";
export {
  createZip,
  type InstallRequest,
  type InstallResult,
  installSkill,
  InvalidArchiveError,
  LocalSkillExistsError,
  maxDownloadBytes,
  maxFileBytes,
  maxFiles,
  maxUnpackedBytes,
  writeMetadata,
  type ZipWriteEntry,
} from "./install.ts";
export {
  createLocalIndex,
  hasSkillFile,
  installedKey,
  type InstallMetadata,
  LocalIndex,
  localInstalledKey,
  MetadataError,
  metadataFileName,
  readMetadata,
  versionsDiffer,
} from "./local.ts";
export { Service } from "./service.ts";
export {
  createSkillHubClient,
  parseSkillHubItem,
  SkillHubClient,
  skillHubDefaultURL,
  skillHubDownloadBaseURL,
  type SkillHubItem,
  skillHubItemSummary,
} from "./skillhubcn.ts";
export * from "./types.ts";
export { readZipEntries, type ZipEntry } from "./zip.ts";
