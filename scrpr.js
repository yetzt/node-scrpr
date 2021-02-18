
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const pkg = require("./package.json");

const quu = require("quu");
const needle = require("needle");

// optional deps (wish there was a nicer pattern)
const cheerio = (function(){ try { return require("cheerio"); } catch (e) { return null; }})();
const xlsx = (function(){ try { return require("xlsx"); } catch (e) { return null; }})();
const yaml = (function(){ try { return require("yaml"); } catch (e) { return null; }})();
const xsv = (function(){ try { return require("xsv"); } catch (e) { return null; }})();
const xml = (function(){ try { return require("xml2js").parseString; } catch (e) { return null; }})();

const scrpr = function(opts){
	if (!(this instanceof scrpr)) return new scrpr(opts);
	const self = this;

	const q = quu(1);

	self.xsv_opts = {
		csv: { sep: 0x2c, quote: 0x22, escape: 0x5c, header: true },
		ssv: { sep: 0x3b, quote: 0x22, escape: 0x5c, header: true },
		tsv: { sep: 0x9, quote: 0x22, escape: 0x5c, header: true },
	};

	self.needle_opts = {
		user_agent: "Mozilla/5.0 (compatible; "+pkg.name+"/"+pkg.version+"; +https://npmjs.com/package/"+pkg.name+")"
	};
	
	self.concurrency = Math.max((parseInt(opts.concurrency,10)||1),1);
	self.cachedir = !!opts.cachedir ? path.resolve(opts.cachedir) : path.resolve(path.dirname(require.main.filename), ".scrpr-cache");

	q.push(function(done){
		fs.mkdir(self.cachedir, { recursive: true }, function(err){
			q.concurrency = self.concurrency;
		});
	});

	return function(){

		// destructure arguments
		const { url, opt, fn } = Array.from(arguments).reduce(function(a,v){
			switch (typeof v) {
				case "string": a.url = v; break;
				case "object": a.opt = v; break;
				case "function": a.fn = v; break;
			}
			return a;
		},{ fn: function(){} });
		if (!!url && !opt.url) opt.url = url;
		
		opt.cache = !!opt.cache;
		opt.method = opt.method || "get";
		opt.data = opt.data || null;
		opt.needle = opt.needle || {};
		opt.successCodes = opt.successCodes || [ 200 ];
		opt.parse = opt.parse || false;
		
		const cachefile = path.resolve(self.cachedir, self.hash(opt.url)+".json");

		(function(next){
			if (!opt.cache) return next(null);
			fs.access(cachefile, (fs.constants.F_OK | fs.constants.R_OK), function(e){
				if (e) return next(null);
				fs.readFile(cachefile, function(err, cache){
					if (err) return next(null);
					try {
						cache = JSON.parse(cache);
					} catch (e) {
						return next(null);
					}
					return next(cache);
				});
			});
		})(function(cache){

			const headers = { ...self.default_headers };
			if (opt.cache && cache && cache.hasOwnProperty("etag") && !!cache.etag) headers["If-None-Match"] = cache.etag;
			else if (opt.cache && cache && cache.hasOwnProperty("modified") && !!cache.modified) headers["If-Modified-Since"] = cache.modified;
			
			const req_opts = {
				...self.needle_opts,
				...opt.needle_opts,
				parse: (opt.parse === "json"), // needle can parse json
				headers: {
					...opt.headers,
					...headers
				}
			};
			
			needle.request(opt.method, opt.url, opt.data, req_opts, function(err, resp, data){
				if (err) return fn(err, false, "error");
				if (resp.statusCode === 304) return fn(null, false, "cache-hit");
				if (opt.successCodes.indexOf(resp.statusCode) <0) return fn(new Error("Got Status Code "+resp.statusCode), false, "error");
				
				const data_hash = self.hash((typeof data === "object") ? JSON.stringify(data) : data);
				
				// check if data changed
				if (opt.cache && cache && data_hash === cache.hash) return fn(null, false, "no-change");
				
				(function(next){
					
					if (!opt.parse) return next(null, data);
					// parse if needed
					switch (opt.parse) {
						case "csv":
						case "tsv":
						case "ssv":
							if (xsv === null) return next(new Error("xsv not available"));
						
							var result = [];
							xsv(self.xsv_opts[opt.parse] ).on("data", function(record){
								result.push(record);
							}).on("end", function(){
								return next(null, result);
							}).end(data);
						
						break;
						case "xlsx":
							if (xlsx === null) return next(new Error("xlsx not available"));
							
							// parse xlsx
							try {
								var table = xlsx.read(data, { type: 'buffer', cellText: false, cellDates: true });
							} catch (err) {
								return next(new Error("XLSX parse error: "+err));
							}
							
							// export sheets
							try {
								var result = table.SheetNames.reduce(function(records, sheetname){
									return records[sheetname] = xlsx.utils.sheet_to_json(table.Sheets[sheetname], { header: 1, dateNF: 'yyyy"-"mm"-"dd' }), records;
								},{});
							} catch (err) {
								return next(new Error("XLSX export error: "+err));
							}
							
							return next(null, result);
							
						break;
						case "yaml":
							if (yaml === null) return next(new Error("yaml not available"));
						
							try {
								data = yaml.parse(data);
							} catch (err) {
								return next(err);
							}

							return next(null, data);

						break;
						case "html":
							if (cheerio === null) return next(new Error("cheerio not available"));
						
							try {
								data = cheerio.load(data);
							} catch (err) {
								return next(err);
							}

							return next(null, data);

						break;
						case "xml":
							if (xml === null) return next(new Error("xml2js not available"));
							return xml(data, next);
						break;
						case "json":
							// done by needle
							return next(null, data);
						break;
						default:
							return next(null, data);
						break;
					}
					
				})(function(err, data){
					if (err) return fn(err, false, "error");

					// assemble and write cache
					fs.writeFile(cachefile, JSON.stringify({
						last: Date.now(),
						hash: data_hash,
						modified: (resp.headers.hasOwnProperty("last-modified") ? resp.headers["last-modified"] : false),
						etag: (resp.headers.hasOwnProperty("etag") ? resp.headers["etag"] : false),
					},null,"\t"), function(err){
						if (err) console.error("Unable to write cache file: %s – %s", cachefile, err);
						return fn(null, true, data);
					});
				});
			});
		});
		
		return self;
		
	};
};


scrpr.prototype.hash = function(v){
	return crypto.createHash("sha256").update(v).digest("hex");
};

module.exports = scrpr;