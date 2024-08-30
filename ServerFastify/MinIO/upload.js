const minioClient = require('./MinIOClient');
const { pipeline } = require('stream'); // Import the stream module
const axios = require('axios');

const CHUNK_SIZE = 1024 * 1024;

// Utility function to format file size
function formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const size = Math.ceil(bytes / Math.pow(k, i));
    return size + " " + sizes[i];
}

async function upload(fastify, options) {
    const { fs, stream } = options;
    fastify.post('/upload', async (request, reply) => {
        let databaseInsertSuccess = false;
        let uploadSuccess = false;
        try {
            const data = request.body.file?.[0]; // Access the first item in the file array, if it exists
            const userString = request.body.user; // user object as string
            const user = JSON.parse(userString); // Parse the user object            

            if (!data) {
                throw new Error('File data is missing or malformed');
            }


            fastify.log.info('#############AUTHENTICATE USER#############');
            // Authenticate the user
            const authResponse = await axios.post('http://nginx/authUser', {
                username: user.username,
                password: user.password
            }, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (authResponse.status !== 200) {
                return reply.code(authResponse.status).send({
                    success: false,
                    message: authResponse.error || 'Login failed'
                });
            }


            //TODO: Check if filename has already been used by the user


            fastify.log.info('#############UPLOAD FILE TO MINIO#############');
            // Check if the bucket exists, if not create it            
            const bucketName = user.username.toLowerCase();
            const exists = await minioClient.bucketExists(bucketName);
            if (!exists) {
                await minioClient.makeBucket(bucketName);
            }

            const fileSize = data.data?.length; // Safely access data.length
            if (!fileSize) {
                throw new Error('File size is missing or malformed');
            }

            const fileName = data.filename;
            const uploadStream = new stream.PassThrough();
            const fileBuffer = data.data; // Buffer contains the file data

            // MinIO upload promise
            const uploadPromise = new Promise((resolve, reject) => {
                minioClient.putObject(bucketName, fileName, uploadStream, fileSize, (err, etag) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(etag);
                    }
                });
            });

            // Pipeline to pipe data from fileBuffer to uploadStream
            uploadStream.end(fileBuffer);
            uploadSuccess = true;
            fastify.log.info('File uploaded successfully.');


            fastify.log.info('#############CREATE METADATA OBJECT#############');
            // Wait for the upload to complete
            const etag = await uploadPromise;
            const serverUrl = `${minioClient.protocol}//${minioClient.host}:${minioClient.port}/${bucketName}/${fileName}`;
            
            // Create metadata object
            const lastDotIndex = fileName.lastIndexOf('.');
            const metadata = {
                name: lastDotIndex !== -1 ? fileName.substring(0, lastDotIndex) : fileName, // Name without extension
                extension: lastDotIndex !== -1 ? fileName.substring(lastDotIndex + 1) : "",
                type: data.mimetype,
                trueSize: fileSize,
                formatedSize: formatBytes(fileSize),
                lastModified: new Date().toISOString(), // ISO-8601 format for the current time
                owner: user.username || null,
            };            


            fastify.log.info('#############INSERT METADATA INTO DATABASE#############');
            // Get Account ID from the database
            const accountResponse = await axios.get('http://nginx/getAccountIdByUsername', {
                params: {
                    username: user.username
                },
                headers: {
                    'Content-Type': 'application/json'
                }
            });       
            const owner_id = accountResponse.data.account_id;

            // Insert metadata into the database            
            const insertResponse = await axios.post('http://nginx/addFile', {
                etag: etag.etag,
                name: metadata.name,
                file_type: metadata.extension,
                size: metadata.trueSize,
                last_modify: metadata.lastModified,
                owner_id: owner_id,
                minIOServer: serverUrl
            }, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (insertResponse.status !== 200) {
                return reply.code(insertResponse.status).send({
                    success: false,
                    message: insertResponse.error || 'Error inserting metadata into the database'
                });
            }
            databaseInsertSuccess = true;   
            

            fastify.log.info('#############CHECK SUCCESSFUL EXECUTION#############');
            //when successful: databaseInsterSuccess = true;
            //else: databaseInsterSuccess = false;            
            if(databaseInsertSuccess && uploadSuccess) {
                return reply.send({
                    success: true,
                    etag,
                    metadata
                });
            }else{
                // TODO: rollback the uploaded file
                // TODO: rollback the database insert
                return reply.code(500).send({
                    success: false,
                    error: 'Error uploading the file and/or metadata'
                });
            }

        } catch (err) {
            fastify.log.error(err);
            if (!reply.sent) {
                reply.status(500).send({ success: false, error: err.message });
            }
        }
    });
}

module.exports = upload;
