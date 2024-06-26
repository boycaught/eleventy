import semver from "semver";
import debugUtil from "debug";

import { getEleventyPackageJson, getWorkingProjectPackageJson } from "./ImportJsonSync.js";

const pkg = getEleventyPackageJson();
const debug = debugUtil("Eleventy:Compatibility");

// Used in user config versionCheck method.
class Compatibility {
	static NORMALIZE_PRERELEASE_REGEX = /-canary\b/g;

	constructor(compatibleRange) {
		this.compatibleRange = Compatibility.getCompatibilityValue(compatibleRange);
	}

	static normalizeIdentifier(identifier) {
		return identifier.replace(Compatibility.NORMALIZE_PRERELEASE_REGEX, "-alpha");
	}

	static getCompatibilityValue(compatibleRange) {
		if (compatibleRange) {
			return compatibleRange;
		}

		try {
			// fetch from project’s package.json
			let projectPackageJson = getWorkingProjectPackageJson();
			return projectPackageJson["11ty"]?.compatibility;
		} catch (e) {
			debug("Could not find a project package.json for compatibility version check: %O", e);
			return; // do nothing, no compatibility information to check
		}
	}

	isCompatible() {
		return Compatibility.satisfies(pkg.version, this.compatibleRange);
	}

	static satisfies(version, compatibleRange) {
		return semver.satisfies(
			Compatibility.normalizeIdentifier(version),
			Compatibility.normalizeIdentifier(compatibleRange),
			{
				includePrerelease: true,
			},
		);
	}

	getErrorMessage() {
		return `We found Eleventy version '${pkg.version}' which does not meet the required version range: '${this.compatibleRange}'. Use \`npm install @11ty/eleventy\` to upgrade your local project to the latest Eleventy version (or \`npm install @11ty/eleventy -g\` to upgrade the globally installed version).`;
	}
}

export default Compatibility;
