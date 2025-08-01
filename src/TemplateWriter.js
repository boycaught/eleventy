import { TemplatePath, isPlainObject } from "@11ty/eleventy-utils";
import debugUtil from "debug";

import Template from "./Template.js";
import TemplateMap from "./TemplateMap.js";
import EleventyBaseError from "./Errors/EleventyBaseError.js";
import { EleventyErrorHandler } from "./Errors/EleventyErrorHandler.js";
import EleventyErrorUtil from "./Errors/EleventyErrorUtil.js";
import ConsoleLogger from "./Util/ConsoleLogger.js";

const debug = debugUtil("Eleventy:TemplateWriter");

class TemplateWriterMissingConfigArgError extends EleventyBaseError {}
class EleventyPassthroughCopyError extends EleventyBaseError {}
class EleventyTemplateError extends EleventyBaseError {}

class TemplateWriter {
	#eleventyFiles;
	#passthroughManager;
	#errorHandler;
	#extensionMap;

	constructor(
		templateFormats, // TODO remove this in favor of this.#eleventyFiles
		templateData,
		templateConfig,
	) {
		if (!templateConfig) {
			throw new TemplateWriterMissingConfigArgError("Missing config argument.");
		}
		this.templateConfig = templateConfig;
		this.config = templateConfig.getConfig();
		this.userConfig = templateConfig.userConfig;

		this.templateFormats = templateFormats;

		this.templateData = templateData;
		this.isVerbose = true;
		this.isDryRun = false;
		this.writeCount = 0;
		this.renderCount = 0;
		this.skippedCount = 0;
		this.isRunInitialBuild = true;

		this._templatePathCache = new Map();
	}

	get dirs() {
		return this.templateConfig.directories;
	}

	get inputDir() {
		return this.dirs.input;
	}

	get outputDir() {
		return this.dirs.output;
	}

	get templateFormats() {
		return this._templateFormats;
	}

	set templateFormats(value) {
		this._templateFormats = value;
	}

	/* Getter for error handler */
	get errorHandler() {
		if (!this.#errorHandler) {
			this.#errorHandler = new EleventyErrorHandler();
			this.#errorHandler.isVerbose = this.verboseMode;
			this.#errorHandler.logger = this.logger;
		}

		return this.#errorHandler;
	}

	/* Getter for Logger */
	get logger() {
		if (!this._logger) {
			this._logger = new ConsoleLogger();
			this._logger.isVerbose = this.verboseMode;
		}

		return this._logger;
	}

	/* Setter for Logger */
	set logger(logger) {
		this._logger = logger;
	}

	/* For testing */
	overrideConfig(config) {
		this.config = config;
	}

	restart() {
		this.writeCount = 0;
		this.renderCount = 0;
		this.skippedCount = 0;
	}

	set extensionMap(extensionMap) {
		this.#extensionMap = extensionMap;
	}

	get extensionMap() {
		if (!this.#extensionMap) {
			throw new Error("Internal error: missing `extensionMap` in TemplateWriter.");
		}
		return this.#extensionMap;
	}

	setPassthroughManager(mgr) {
		this.#passthroughManager = mgr;
	}

	setEleventyFiles(eleventyFiles) {
		this.#eleventyFiles = eleventyFiles;
	}

	// Tests
	getPassthroughGlobs() {
		return this.#eleventyFiles?.passthroughGlobs;
	}

	getPathsWithVirtualTemplates(paths) {
		// Support for virtual templates added in 3.0
		if (this.config.virtualTemplates && isPlainObject(this.config.virtualTemplates)) {
			let virtualTemplates = Object.keys(this.config.virtualTemplates)
				.filter((path) => {
					// Filter out includes/layouts
					return this.dirs.isTemplateFile(path);
				})
				.map((path) => {
					let fullVirtualPath = this.dirs.getInputPath(path);
					if (!this.extensionMap.getKey(fullVirtualPath)) {
						throw new Error(
							`The virtual template at ${fullVirtualPath} is using a template format that’s not valid for your project. Your project is using: "${this.formats}". Read more about formats: https://v3.11ty.dev/docs/config/#template-formats`,
						);
					}
					return fullVirtualPath;
				});

			paths = paths.concat(virtualTemplates);

			// Virtual templates can not live at the same place as files on the file system!
			if (paths.length !== new Set(paths).size) {
				let conflicts = {};
				for (let path of paths) {
					if (conflicts[path]) {
						throw new Error(
							`A virtual template had the same path as a file on the file system: "${path}"`,
						);
					}

					conflicts[path] = true;
				}
			}
		}

		return paths;
	}

	async _getAllPaths() {
		if (!this.#eleventyFiles) {
			return this.getPathsWithVirtualTemplates([]);
		}

		// this is now cached upstream by FileSystemSearch
		let paths = await this.#eleventyFiles.getFiles();
		paths = this.getPathsWithVirtualTemplates(paths);
		return paths;
	}

	_createTemplate(path, to = "fs") {
		let tmpl = this._templatePathCache.get(path);
		let wasCached = false;

		if (tmpl) {
			wasCached = true;
			// Update config for https://github.com/11ty/eleventy/issues/3468
			// TODO reset other constructor things here like inputDir/outputDir
			tmpl.resetCachedTemplate({
				templateData: this.templateData,
				extensionMap: this.extensionMap,
				eleventyConfig: this.templateConfig,
			});
		} else {
			tmpl = new Template(path, this.templateData, this.extensionMap, this.templateConfig);
			tmpl.setOutputFormat(to);
			tmpl.logger = this.logger;
			this._templatePathCache.set(path, tmpl);
		}

		tmpl.setTransforms(this.config.transforms);
		tmpl.setLinters(this.config.linters);
		tmpl.setDryRun(this.isDryRun);
		tmpl.setIsVerbose(this.isVerbose);
		tmpl.reset();

		return {
			template: tmpl,
			wasCached,
		};
	}

	// incrementalFileShape is `template` or `copy` (for passthrough file copy)
	async _addToTemplateMapIncrementalBuild(incrementalFileShape, paths, to = "fs") {
		// Render overrides are only used when `--ignore-initial` is in play and an initial build is not run
		let ignoreInitialBuild = !this.isRunInitialBuild;
		let secondOrderRelevantLookup = {};
		let templates = [];

		let promises = [];
		for (let path of paths) {
			let { template: tmpl } = this._createTemplate(path, to);

			// Note: removed a fix here to fetch missing templateRender instances
			// that was tested as no longer needed (Issue #3170)
			// Related: #3870, improved configuration reset

			templates.push(tmpl);

			// required for tmpl.isFileRelevantToThisTemplate below
			await tmpl.asyncTemplateInitialization();

			// This must happen before data is generated for the incremental file only
			if (incrementalFileShape === "template" && tmpl.inputPath === this.incrementalFile) {
				tmpl.resetCaches();
			} else if (
				// Issue #3824 #3870
				tmpl.isFileRelevantToThisTemplate(this.incrementalFile, {
					isFullTemplate: incrementalFileShape === "template",
				})
			) {
				tmpl.resetCaches();
			}

			// IMPORTANT: This is where the data is first generated for the template
			promises.push(this.templateMap.add(tmpl));
		}

		// Important to set up template dependency relationships first
		await Promise.all(promises);

		// Delete incremental file from the dependency graph so we get fresh entries!
		// This _must_ happen before any additions, the other ones are in Custom.js and GlobalDependencyMap.js (from the eleventy.layouts Event)
		this.config.uses.resetNode(this.incrementalFile);

		// write new template relationships to the global dependency graph for next time
		this.templateMap.addAllToGlobalDependencyGraph();

		// Always disable render for --ignore-initial
		if (ignoreInitialBuild) {
			for (let tmpl of templates) {
				tmpl.setRenderableOverride(false); // disable render
			}
			return;
		}

		for (let tmpl of templates) {
			if (incrementalFileShape === "template" && tmpl.inputPath === this.incrementalFile) {
				tmpl.setRenderableOverride(undefined); // unset, probably render
			} else if (
				tmpl.isFileRelevantToThisTemplate(this.incrementalFile, {
					isFullTemplate: incrementalFileShape === "template",
				})
			) {
				// changed file is used by template
				// template uses the changed file
				tmpl.setRenderableOverride(undefined); // unset, probably render
				secondOrderRelevantLookup[tmpl.inputPath] = true;
			} else if (this.config.uses.isFileUsedBy(this.incrementalFile, tmpl.inputPath)) {
				// changed file uses this template
				tmpl.setRenderableOverride("optional");
			} else {
				// For incremental, always disable render on irrelevant templates
				tmpl.setRenderableOverride(false); // disable render
			}
		}

		let secondOrderRelevantArray = this.config.uses
			.getTemplatesRelevantToTemplateList(Object.keys(secondOrderRelevantLookup))
			.map((entry) => TemplatePath.addLeadingDotSlash(entry));
		let secondOrderTemplates = Object.fromEntries(
			Object.entries(secondOrderRelevantArray).map(([index, value]) => [value, true]),
		);

		for (let tmpl of templates) {
			// second order templates must also be rendered if not yet already rendered at least once and available in cache.
			if (secondOrderTemplates[tmpl.inputPath]) {
				if (tmpl.isRenderableDisabled()) {
					tmpl.setRenderableOverride("optional");
				}
			}
		}

		// Order of templates does not matter here, they’re reordered later based on dependencies in TemplateMap.js
		for (let tmpl of templates) {
			if (incrementalFileShape === "template" && tmpl.inputPath === this.incrementalFile) {
				// Cache is reset above (to invalidate data cache at the right time)
				tmpl.setDryRunViaIncremental(false);
			} else if (!tmpl.isRenderableDisabled() && !tmpl.isRenderableOptional()) {
				// Related to the template but not the template (reset the render cache, not the read cache)
				tmpl.resetCaches({
					data: true,
					render: true,
				});

				tmpl.setDryRunViaIncremental(false);
			} else {
				// During incremental we only reset the data cache for non-matching templates, see https://github.com/11ty/eleventy/issues/2710
				// Keep caches for read/render
				tmpl.resetCaches({
					data: true,
				});

				tmpl.setDryRunViaIncremental(true);

				this.skippedCount++;
			}
		}
	}

	async _addToTemplateMapFullBuild(paths, to = "fs") {
		if (this.incrementalFile) {
			return [];
		}

		let ignoreInitialBuild = !this.isRunInitialBuild;
		let promises = [];
		for (let path of paths) {
			let { template: tmpl, wasCached } = this._createTemplate(path, to);
			// Render overrides are only used when `--ignore-initial` is in play and an initial build is not run
			if (ignoreInitialBuild) {
				tmpl.setRenderableOverride(false); // disable render
			} else {
				tmpl.setRenderableOverride(undefined); // unset, render
			}

			if (wasCached) {
				tmpl.resetCaches();
			}

			// IMPORTANT: This is where the data is first generated for the template
			promises.push(this.templateMap.add(tmpl));
		}

		return Promise.all(promises);
	}

	getFileShape(paths, incrementalFile) {
		// WARNING: This is leaky—if Core is being used instead of Eleventy we are assuming everything is a template (not passthrough copy)
		if (!this.#eleventyFiles) {
			return "template";
		}

		return this.#eleventyFiles.getFileShape(paths, incrementalFile);
	}

	async _addToTemplateMap(paths, to = "fs") {
		let incrementalFileShape = this.getFileShape(paths, this.incrementalFile);

		// Filter out passthrough copy files
		paths = paths.filter((path) => {
			if (!this.extensionMap.hasEngine(path)) {
				return false;
			}
			if (incrementalFileShape === "copy") {
				this.skippedCount++;
				// Filters out templates if the incremental file is a passthrough copy file
				return false;
			}
			return true;
		});

		if (this.incrementalFile) {
			// Top level async to get at the promises returned.
			return await this._addToTemplateMapIncrementalBuild(incrementalFileShape, paths, to);
		}

		// Full Build
		let ret = await this._addToTemplateMapFullBuild(paths, to);

		// write new template relationships to the global dependency graph for next time
		this.templateMap.addAllToGlobalDependencyGraph();

		return ret;
	}

	async _createTemplateMap(paths, to) {
		this.templateMap = new TemplateMap(this.templateConfig);

		await this._addToTemplateMap(paths, to);
		await this.templateMap.cache();

		// Return is used by tests
		return this.templateMap;
	}

	async _generateTemplate(mapEntry, to) {
		let tmpl = mapEntry.template;

		return tmpl.generateMapEntry(mapEntry, to).then((pages) => {
			this.renderCount += tmpl.getRenderCount();
			this.writeCount += tmpl.getWriteCount();
			return pages;
		});
	}

	async writePassthroughCopy(templateExtensionPaths) {
		if (!this.#passthroughManager) {
			throw new Error("Internal error: Missing `passthroughManager` instance.");
		}

		return this.#passthroughManager.copyAll(templateExtensionPaths).catch((e) => {
			this.errorHandler.warn(e, "Error with passthrough copy");
			return Promise.reject(new EleventyPassthroughCopyError("Having trouble copying", e));
		});
	}

	async generateTemplates(paths, to = "fs") {
		let promises = [];
		// TODO optimize await here
		await this._createTemplateMap(paths, to);
		debug("Template map created.");

		let usedTemplateContentTooEarlyMap = [];
		for (let mapEntry of this.templateMap.getMap()) {
			promises.push(
				this._generateTemplate(mapEntry, to).catch(function (e) {
					// Premature templateContent in layout render, this also happens in
					// TemplateMap.populateContentDataInMap for non-layout content
					if (EleventyErrorUtil.isPrematureTemplateContentError(e)) {
						usedTemplateContentTooEarlyMap.push(mapEntry);
					} else {
						let outputPaths = `"${mapEntry._pages.map((page) => page.outputPath).join(`", "`)}"`;
						return Promise.reject(
							new EleventyTemplateError(
								`Having trouble writing to ${outputPaths} from "${mapEntry.inputPath}"`,
								e,
							),
						);
					}
				}),
			);
		}

		for (let mapEntry of usedTemplateContentTooEarlyMap) {
			promises.push(
				this._generateTemplate(mapEntry, to).catch(function (e) {
					return Promise.reject(
						new EleventyTemplateError(
							`Having trouble writing to (second pass) "${mapEntry.outputPath}" from "${mapEntry.inputPath}"`,
							e,
						),
					);
				}),
			);
		}

		return promises;
	}

	// Similiar to `write()` but skips passthrough copy
	async writeTemplates() {
		let paths = await this._getAllPaths();

		return Promise.all(await this.generateTemplates(paths)).then(
			(templateResults) => {
				return {
					// New in 3.0: flatten and filter out falsy templates
					templates: templateResults.flat().filter(Boolean),
				};
			},
			(e) => {
				return Promise.reject(e);
			},
		);
	}

	async write() {
		let paths = await this._getAllPaths();

		// This must happen before writePassthroughCopy
		this.templateConfig.userConfig.emit("eleventy#beforerender");

		let aggregatePassthroughCopyPromise = this.writePassthroughCopy(paths);

		let templatesPromise = Promise.all(await this.generateTemplates(paths)).then((results) => {
			this.templateConfig.userConfig.emit("eleventy#render");

			return results;
		});

		return Promise.all([aggregatePassthroughCopyPromise, templatesPromise]).then(
			async ([passthroughCopyResults, templateResults]) => {
				return {
					passthroughCopy: passthroughCopyResults,
					// New in 3.0: flatten and filter out falsy templates
					templates: templateResults.flat().filter(Boolean),
				};
			},
			(e) => {
				return Promise.reject(e);
			},
		);
	}

	// Passthrough copy not supported in JSON output.
	// --incremental not supported in JSON output.
	async getJSON(to = "json") {
		let paths = await this._getAllPaths();
		let promises = await this.generateTemplates(paths, to);

		return Promise.all(promises).then(
			(templateResults) => {
				return {
					// New in 3.0: flatten and filter out falsy templates
					templates: templateResults.flat().filter(Boolean),
				};
			},
			(e) => {
				return Promise.reject(e);
			},
		);
	}

	setVerboseOutput(isVerbose) {
		this.isVerbose = isVerbose;
		this.errorHandler.isVerbose = isVerbose;
	}

	setDryRun(isDryRun) {
		this.isDryRun = Boolean(isDryRun);
	}

	setRunInitialBuild(runInitialBuild) {
		this.isRunInitialBuild = runInitialBuild;
	}
	setIncrementalBuild(isIncremental) {
		this.isIncremental = isIncremental;
	}
	setIncrementalFile(incrementalFile) {
		this.incrementalFile = incrementalFile;
		this.#passthroughManager?.setIncrementalFile(incrementalFile);
	}
	resetIncrementalFile() {
		this.incrementalFile = null;
		this.#passthroughManager?.resetIncrementalFile();
	}

	getMetadata() {
		return {
			// copyCount, copySize
			...(this.#passthroughManager?.getMetadata() || {}),
			skipCount: this.skippedCount,
			writeCount: this.writeCount,
			renderCount: this.renderCount,
		};
	}

	get caches() {
		return ["_templatePathCache"];
	}
}

export default TemplateWriter;
