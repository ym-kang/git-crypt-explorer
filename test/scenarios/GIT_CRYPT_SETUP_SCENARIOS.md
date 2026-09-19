# Git Crypt Setup Scenarios

This document is the single source of truth for the initial setup scenarios that the PyCharm/IntelliJ plugin and the VS Code extension must support. Each platform uses its own implementation, but the scenario IDs and expected results are shared.

## Shared Scenarios

| ID | Condition | User prompt / expected result | PyCharm/IntelliJ test | VS Code test |
| --- | --- | --- | --- | --- |
| SC-001 | The project folder is empty and is not a Git repository | Ask whether Git should be initialized first. If confirmed, run `git init` in the folder and rediscover the repository. | `GitCryptSetupScenarioTest.emptyFolderCanBeInitializedAndDiscoveredAsGitRepository` in `intellij-plugin/src/test/kotlin/com/ymkang/gitcryptexplorer/scenarios/GitCryptSetupScenarioTest.kt` | `SC-001: empty folder can be initialized and discovered as a Git repository` in `test/scenarios/gitCryptSetupScenario.test.ts` |
| SC-002 | At least one git-crypt target exists and the local repository state is locked | Ask whether to unlock the repository and allow either GPG unlock or an existing symmetric key. | `GitCryptSetupScenarioTest.protectedFilesInLockedRepositoryRecommendUnlock` in `intellij-plugin/src/test/kotlin/com/ymkang/gitcryptexplorer/scenarios/GitCryptSetupScenarioTest.kt` | `SC-002: protected files in a locked repository recommend unlock` in `test/scenarios/gitCryptSetupScenario.test.ts` |
| SC-003 | No git-crypt targets exist and no local key is configured | Ask whether to initialize git-crypt with a new key. | `GitCryptSetupScenarioTest.repositoryWithoutTargetsOrLocalKeyRecommendsNewGitCryptKey` in `intellij-plugin/src/test/kotlin/com/ymkang/gitcryptexplorer/scenarios/GitCryptSetupScenarioTest.kt` | `SC-003: repository without targets or a local key recommends a new git-crypt key` in `test/scenarios/gitCryptSetupScenario.test.ts` |
| SC-004 | No local git-crypt key is available before adding or removing an encryption target | Inspect the repository before changing targets. If it is locked, not initialized, or the CLI is unavailable, do not modify `.gitattributes` and show an explanatory error. Proceed only when the repository is unlocked. | `GitCryptSetupScenarioTest.encryptionTargetChangesRequireAnInstalledUnlockedKey` in `intellij-plugin/src/test/kotlin/com/ymkang/gitcryptexplorer/scenarios/GitCryptSetupScenarioTest.kt` | `SC-004: encryption target changes require an installed unlocked key` in `test/scenarios/gitCryptSetupScenario.test.ts` |
| SC-005 | A file is encrypted in the Git index | Add `Show Indexed Ciphertext` to the context menu and display the indexed blob as a read-only hex view without changing the working tree. | `GitCryptSetupScenarioTest.encryptedIndexContentCanBeReadWithoutChangingTheWorkingTree` in `intellij-plugin/src/test/kotlin/com/ymkang/gitcryptexplorer/scenarios/GitCryptSetupScenarioTest.kt`; `ShowIndexedCiphertextActionTest` verifies the IntelliJ action update contract in `intellij-plugin/src/test/kotlin/com/ymkang/gitcryptexplorer/actions/ShowIndexedCiphertextActionTest.kt` | `SC-005: encrypted index content can be read without changing the working tree` in `test/scenarios/gitCryptSetupScenario.test.ts` |

## Implementation Mapping

- The pure setup decision logic for PyCharm/IntelliJ is implemented by `recommendGitCryptSetup` in `intellij-plugin/src/main/kotlin/com/ymkang/gitcryptexplorer/core/GitCryptSetup.kt`.
- The PyCharm/IntelliJ Git initialization UI entry point is `initializeGitRepositoryWithPrompt` in `intellij-plugin/src/main/kotlin/com/ymkang/gitcryptexplorer/ui/UiSupport.kt`.
- The pure setup decision logic for VS Code is implemented by `recommendGitCryptSetup` in `src/gitCrypt/setupRecommendation.ts`.
- The VS Code guided setup UI is implemented by `GitCryptSetupGuide` in `src/gitCrypt/setupGuide.ts`.
- The VS Code command entry point that confirms and initializes Git when no repository exists is `src/commands/selectRepository.ts`.
- Add/remove target key validation is performed by calling `gitCryptTargetOperationError` from the PyCharm/IntelliJ `GitCryptActions.kt` and VS Code `updateFileProtection.ts` implementations.
- Both platforms use their respective `GitClient.initialize` implementation to initialize Git in an empty folder.
- The indexed ciphertext view is provided by the PyCharm/IntelliJ `ShowIndexedCiphertextAction` and the VS Code `showIndexedCiphertext` command. Both read the stage-zero Git index blob and render a bounded hex preview.
- The IntelliJ action UI contract is tested by `ShowIndexedCiphertextActionTest`; it verifies background action updates and the hidden state when no project file context is available.

## Running the Tests

```bash
# VS Code
npm test

# PyCharm/IntelliJ plugin
cd intellij-plugin
gradle test
```

Tests that simulate clicking the actual confirmation and cancellation dialogs require each IDE's GUI test environment. The current automated tests verify a real `git init` in a temporary folder, the pure state branches, and the IntelliJ action update contract. The UI text and follow-up commands can be reviewed in the implementation files mapped above.
