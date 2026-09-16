package com.ymkang.gitcryptexplorer.core

enum class GitCryptAttributeMode { PROTECT, UNPROTECT }
enum class GitCryptAttributeTarget { FILE, DIRECTORY }

data class GitAttributesUpdate(val contents: String, val changed: Boolean, val rule: String)

fun updateGitAttributes(contents: String, relativePath: String, mode: GitCryptAttributeMode, target: GitCryptAttributeTarget = GitCryptAttributeTarget.FILE): GitAttributesUpdate {
    val escapedPath = escapeWildmatch(relativePath.removeSuffix("/"))
    val pattern = quotePattern("/$escapedPath${if (target == GitCryptAttributeTarget.DIRECTORY) "/**" else ""}")
    val protectRule = "$pattern filter=git-crypt diff=git-crypt"
    val unprotectRule = "$pattern !filter !diff"
    val desiredRule = if (mode == GitCryptAttributeMode.PROTECT) protectRule else unprotectRule
    val eol = if (contents.contains("\r\n")) "\r\n" else "\n"
    val hasFinalEol = contents.endsWith("\n")
    val lines = if (contents.isEmpty()) mutableListOf() else contents.split(Regex("\r?\n")).toMutableList()
    var appended = false
    var changed = false
    if (hasFinalEol) lines.removeLast()
    val matching = lines.indexOfLast { it.trim() == protectRule || it.trim() == unprotectRule }
    if (matching >= 0) {
        if (lines[matching].trim() != desiredRule) {
            lines[matching] = desiredRule
            changed = true
        }
    } else {
        lines.add(desiredRule)
        appended = true
        changed = true
    }
    if (mode == GitCryptAttributeMode.PROTECT && target == GitCryptAttributeTarget.DIRECTORY) {
        val exemption = "${quotePattern("/$escapedPath/**/.gitattributes")} !filter !diff"
        val mainIndex = lines.indexOfLast { it.trim() == desiredRule }
        val exemptionIndex = lines.indexOfLast { it.trim() == exemption }
        if (exemptionIndex < mainIndex) {
            lines.add(exemption)
            appended = true
            changed = true
        }
    }
    if (!changed) return GitAttributesUpdate(contents, false, desiredRule)
    return GitAttributesUpdate(lines.joinToString(eol) + if (appended || hasFinalEol) eol else "", true, desiredRule)
}

private fun escapeWildmatch(value: String) = value.replace(Regex("[\\\\*?\\[\\]]")) { "\\${it.value}" }

private fun quotePattern(value: String): String = buildString {
    append('"')
    value.forEach { character ->
        when {
            character == '"' || character == '\\' -> append('\\').append(character)
            character.code < 0x20 || character.code == 0x7f -> append('\\').append(character.code.toString(8).padStart(3, '0'))
            else -> append(character)
        }
    }
    append('"')
}
