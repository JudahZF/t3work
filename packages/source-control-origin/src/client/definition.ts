import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControlClient,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
} from "@t3tools/source-control-core/client/definition";

const KIND = SourceControlProviderKind.make("cursor-origin");

/** Origin has one public instance: git lives on this host, its web pages on `cursor.com`. */
export const ORIGIN_GIT_HOST = "origin.cursor.com";

const CHECKOUT_COMMAND = /^origin\s+pr\s+checkout\s+(.+)$/i;
const CHANGE_REQUEST_URL =
  /^https:\/\/(?:www\.)?cursor\.com\/codebase\/[^/\s]+\/[^/\s]+\/pull\/\d+(?:[/?#].*)?$/i;

export const definition = defineSourceControlClient({
  kind: KIND,
  label: "Cursor Origin",
  pickerLabel: "Cursor Origin",
  icon: "cursor-origin",
  changeRequest: { shortLabel: "PR", singular: "pull request" },
  repositoryPathHint: "owner/repo",
  publicHost: ORIGIN_GIT_HOST,
  publishDescription: ORIGIN_GIT_HOST,
  publishHost: () => ORIGIN_GIT_HOST,
  newRepositoryOwner: (account) => (account ? { owner: account } : null),
  // Origin repositories are internal or private; there is no public visibility.
  publishVisibilities: ["private"],
  // `origin repo clone` clones over HTTPS, so that is the transport a signed-in CLI can serve.
  defaultCloneTransport: "https",
  changeRequestUrl: ({ repository, number }) =>
    `https://cursor.com/codebase/${repository}/pull/${number}`,
  changeRequestActions: new Set([
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "delete-branch",
    "enable-auto-merge",
    "disable-auto-merge",
  ] as const),
  checkoutCommand: ({ number }) => `origin pr checkout ${number}`,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input)?.[1]?.trim() ?? null,
  isChangeRequestReference: (url) => CHANGE_REQUEST_URL.test(url),
  // Pull request pages are on cursor.com, but the repository they belong to is on the git host.
  changeRequestUrlHost: () => ORIGIN_GIT_HOST,
  checkoutChangeRequestHost: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(KIND, identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(KIND, identity, link),
  isChangeRequestUrl: (url) => CHANGE_REQUEST_URL.test(url),
});
