import fastq, { queueAsPromised } from "fastq";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";

import { allowedMimeTypes, asyncTask, ProcessingFileData, UploadTypes } from "../interfaces/media.js";
import { logger } from "./logger.js";
import config, { has } from "config";
import { dbFileHashupdate, dbFileMagnetUpdate, dbFileStatusUpdate, dbFileVisibilityUpdate, dbFileDimensionsUpdate, dbFileblurhashupdate, dbFilesizeUpdate, dbFilePercentageUpdate } from "./database.js";
import {fileTypeFromBuffer} from 'file-type';
import { Request } from "express";
import app from "../app.js";
import { generateBlurhash, generatefileHashfromfile } from "./hash.js";
import crypto from "crypto";
import { getClientIp } from "./server.js";
import { CreateMagnet } from "./torrent.js";

const requestQueue: queueAsPromised<any> = fastq.promise(PrepareFile, 1); //number of workers for the queue

async function PrepareFile(t: asyncTask): Promise<void> {

	//Show queue status
	logger.info(`Processing item, queue size = ${requestQueue.length() +1}`);

	if (!t.req.file) {
		logger.error("ERR -> Preparing file for conversion, empty file");
		return;
	}

	if (!t.req.file.mimetype) {
		logger.error("ERR -> Preparing file for conversion, empty mimetype");
		return;
	}

	if (!t.filedata.media_type) {
		logger.error("ERR -> Preparing file for conversion, empty type");
		return;
	}

	if (!t.filedata.username) {
		logger.error("ERR -> Preparing file for conversion, empty username");
		return;
	}

	logger.info(
		"Processing file",
		":",
		t.req.file.originalname,
		"=>",
		`${t.filedata.filename}`
	);

	await convertFile(t.req.file, t.filedata, 0);

}

async function convertFile(	inputFile: any,	options: ProcessingFileData,retry:number = 0): Promise<boolean> {

	if (retry > 5) {return false}

	const TempPath = config.get("media.tempPath") + crypto.randomBytes(8).toString('hex') + options.filename;

	logger.info("Using temp path:", TempPath);
	let NewDimensions = setMediaDimensions(TempPath, options);
	let result = new Promise(async(resolve, reject) => {

		//We write the file on filesystem because ffmpeg doesn't support streams.
		fs.writeFile(TempPath, inputFile.buffer, function (err) {
			if (err) {
				logger.error(err);
				reject(err);
				return;
			}
		});

		//Set status processing on the database
		const processing =  dbFileStatusUpdate("processing", options);
		if (!processing) {
			logger.error("Could not update table mediafiles, id: " + options.fileid, "status: processing");
		}

		const MediaPath = config.get("media.mediaPath") + options.username + "/" + options.filename;
		logger.info("Using media path:", MediaPath);

		let MediaDuration: number = 0;
		let ConversionDuration : number = 0;
		let newfiledimensions = (await NewDimensions).toString()

		let ConversionEngine = ffmpeg(TempPath)
			.outputOption(["-loop 0"]) //Always loop. If is an image it will not apply.
			.setSize(newfiledimensions)
			.output(MediaPath)
			.toFormat(options.filename.split(".").pop() || "")

		if (options.filename.split(".").pop() == "webp" && options.originalmime != "image/gif") {
			ConversionEngine.frames(1); //Fix IOS issue when uploading some portrait images.
		}
			
		if (options.outputoptions != "") {
			ConversionEngine.outputOptions(options.outputoptions)
		}

		ConversionEngine
			.on("end", async(end) => {
			
				fs.unlink(TempPath, (err) => {
				if (err) {
					logger.error(err);

					reject(err);

					return;
				}
				});

				// if (options.originalmime.toString().startsWith("image")){
				// 	const blurhash =  dbFileblurhashupdate(await generateBlurhash(inputFile), options);
				// 	if (!blurhash) {
				// 		logger.error("Could not update table mediafiles, id: " + options.fileid, "blurhash for file: " + TempPath);
				// 	}
		
				// }

				const percentage = dbFilePercentageUpdate("100", options);
				if (!percentage) {
					logger.error("Could not update table mediafiles, id: " + options.fileid, "percentage: 100");
				}

				const visibility = dbFileVisibilityUpdate(true, options);
				if (!visibility) {
					logger.error("Could not update table mediafiles, id: " + options.fileid, "visibility: true");
				}

				let hash = generatefileHashfromfile(MediaPath);
				options.hash = hash;
				logger.info("Hash for file:", options.filename, ":", hash);
				const hashDBUpdate =  dbFileHashupdate(options);
				if (!hashDBUpdate) {
					logger.error("Could not update table mediafiles, id: " + options.fileid, "hash for file: " + MediaPath);
				}
				
				//Create magnet link
				CreateMagnet(MediaPath, options);

				const fileStatusDbUpdate =  dbFileStatusUpdate("success", options);
				if (!fileStatusDbUpdate) {
					logger.error("Could not update table mediafiles, id: " + options.fileid, "status: completed");
				}

				logger.debug("Old Filesize:", options.filesize);
				
				let newfilesize : number = 0;
				try{
					newfilesize = +fs.statSync(MediaPath).size;
					logger.debug("New Filesize:", newfilesize);
				}catch(err){
					logger.error(err);
				}

				const filesizeDbUpdate =  dbFilesizeUpdate(newfilesize, options);
				if (!filesizeDbUpdate) {
					logger.error("Could not update table mediafiles, id: " + options.fileid, "status: completed");
				}

				const dimensionsDbUpdate =  dbFileDimensionsUpdate(+newfiledimensions.split("x")[0], +newfiledimensions.split("x")[1], options);
				if (!dimensionsDbUpdate) {
					logger.error("Could not update table mediafiles, id: " + options.fileid, "dimensions for file: " + MediaPath);
				}
			
				logger.info(`File converted successfully: ${MediaPath} ${ConversionDuration /2} seconds`);

				resolve(end);

			})
			.on("error", (err) => {

				logger.warn(`Error converting file, retrying file conversion: ${options.filename} retry: ${retry}/5`);
				logger.error(err);
				retry++
				fs.unlink(TempPath, (err) => {
					if (err) {
						logger.error(err);
	
						reject(err);
	
						return;
					}
				});

				if (retry > 5){
					logger.error(`Error converting file after 5 retries: ${inputFile.originalname}`);
					const errorstate =  dbFileStatusUpdate("error", options);
					if (!errorstate) {
						logger.error("Could not update table mediafiles, id: " + options.fileid, "status: failed");
					}
					resolve(err);
				}
				convertFile(inputFile, options, retry);
				resolve(err);

			})
			.on("codecData", (data) => {
				MediaDuration = parseInt(data.duration.replace(/:/g, ""));
			})
			.on("progress", (data) => {

				const time = parseInt(data.timemark.replace(/:/g, ""));
				let percent: number = (time / MediaDuration) * 100;
				ConversionDuration = ConversionDuration + 1;
				if (percent < 0) {
					percent = 0;
				}
		
				if (percent %4 > 0 && percent %4 < 1){
					logger.debug(
						`Processing : ` +
							`${options.filename} - ${Number(percent).toFixed(0)} %`
					);
				dbFilePercentageUpdate(Number(percent).toFixed(0), options);	
				}
				
			})
			.run();
	
	});

	return result.then(() => true).catch(() => false);
	
}

const ParseMediaType = (req : Request, pubkey : string): string  => {

	let media_type = "";

	//v0 compatibility, check if type is present on request body (v0 uses type instead of uploadtype)
	if (req.body.type != undefined && req.body.type != "") {
		logger.warn("Detected 'type' field (deprecated v0) on request body, setting 'media_type' with 'type' data ", "|", getClientIp(req));
		media_type = req.body.type;
	}

	//v1 compatibility, check if uploadtype is present on request body (v1 uses uploadtype instead of media_type)
	if (req.body.uploadtype != undefined && req.body.uploadtype != "") {
		logger.warn("Detected 'uploadtype' field (deprecated v1) on request body, setting 'media_type' with 'type' data ", "|", getClientIp(req));
		media_type = req.body.uploadtype;
	}

	//v2 compatibility, check if media_type is present on request body
	if (req.body.media_type != undefined && req.body.media_type != "") {
		media_type = req.body.media_type;
	}
	
	//Check if media_type is valid
	if (!UploadTypes.includes(media_type)) {
		logger.warn(`Incorrect uploadtype or not present: `, media_type, "assuming uploadtype = media", "|", getClientIp(req));
		media_type = ("media");
	}

	//Check if the pubkey is public (the server pubkey) and media_type is different than media
	if (pubkey == app.get("pubkey") && media_type != "media") {
		logger.warn(`Public pubkey can only upload media files, setting media_type to "media"`, "|", getClientIp(req));
		media_type = "media";
	}

	return media_type;

}

const ParseFileType = async (req: Request, file :Express.Multer.File): Promise<string> => {

	//Detect file mime type
	const DetectedFileType = await fileTypeFromBuffer(file.buffer);
	if (DetectedFileType == undefined) {
		logger.warn(`RES -> 400 Bad request - Could not detect file mime type `,  "|", getClientIp(req));
		return "";
	}
	
	//Check if filetype is allowed
	if (!allowedMimeTypes.includes(DetectedFileType.mime)) {
		logger.warn(`RES -> 400 Bad request - filetype not allowed: `, DetectedFileType.mime,  "|", getClientIp(req));
		return "";
	}

	return DetectedFileType.mime;

}

export {convertFile, requestQueue, ParseMediaType, ParseFileType };

 async function setMediaDimensions(file:string, options:ProcessingFileData):Promise<string> {

	const response:string = await new Promise ((resolve) => {
		ffmpeg.ffprobe(file, (err, metadata) => {
		if (err) {
			logger.error("Could not get media dimensions of file: " + options.filename + " using default min width (640px)");
			resolve("640x480"); //Default min width
			return;
		} else {
		
			let mediaWidth = metadata.streams[0].width;
			let mediaHeight = metadata.streams[0].height;
			let newWidth = options.width;
			let newHeight = options.height;

			if (!mediaWidth || !mediaHeight) {
				logger.warn("Could not get media dimensions of file: " + options.filename + " using default min width (640px)");
				resolve("640x480"); //Default min width
				return;
			}

			if (mediaWidth > newWidth || mediaHeight > newHeight) {
				if (mediaWidth > mediaHeight) {
				  newHeight = (mediaHeight / mediaWidth) * newWidth;
				} else {
				  newWidth = (mediaWidth / mediaHeight) * newHeight;
				}
			  }else{
				newWidth = mediaWidth;
				newHeight = mediaHeight;
			  }

			//newHeigt truncated to 0 decimals
			newWidth = Math.trunc(+newWidth);
			newHeight = Math.trunc(+newHeight);

			logger.debug("Origin dimensions:", +mediaWidth + "px", +mediaHeight + "px",);
			logger.info("Output dimensions:", +newWidth + "px", +newHeight + "px",);		

			resolve(newWidth + "x" + newHeight);
		}})

		});

		return response;
}