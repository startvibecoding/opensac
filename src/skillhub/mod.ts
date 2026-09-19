// Public surface of src/skillhub (ported from internal/skillhub).

export {
  cloneCategories,
  cloneSearchPage,
  cloneSkillDetail,
  MemoryCache,
  newMemoryCache,
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
  maxClawContentBytes,
  maxClawJSONBytes,
  newClawHubClient,
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
  decodeJSON,
  defaultHttpClient,
  defaultMaxJSONBytes,
  defaultRequestTimeout,
  endpoint as buildEndpoint,
  errBodyBytes,
  getJSON,
  getWithStatus,
  type HttpClient,
  newHTTPClient,
  statusText,
} from "./http.ts";
export {
  createZip,
  Install as installSkill,
  type InstallRequest,
  type InstallResult,
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
  hasSkillFile,
  installedKey,
  type InstallMetadata,
  LocalIndex,
  localInstalledKey,
  MetadataError,
  metadataFileName,
  newLocalIndex,
  readMetadata,
  versionsDiffer,
} from "./local.ts";
export { Service } from "./service.ts";
export {
  newSkillHubClient,
  parseSkillHubItem,
  SkillHubClient,
  skillHubDefaultURL,
  skillHubDownloadBaseURL,
  type SkillHubItem,
  skillHubItemSummary,
} from "./skillhubcn.ts";
export * from "./types.ts";
export { readZipEntries, type ZipEntry } from "./zip.ts";
