const { MongoClient } = require('mongodb');
const uri = "mongodb://ysfvoiddev_db_user:lOjum4WzKHDKNvwC@ac-qo7dunh-shard-00-00.gbvhhzi.mongodb.net:27017,ac-qo7dunh-shard-00-01.gbvhhzi.mongodb.net:27017,ac-qo7dunh-shard-00-02.gbvhhzi.mongodb.net:27017/voidtools?ssl=true&replicaSet=atlas-qo7dunh-shard-0&authSource=admin&retryWrites=true&w=majority";
const client = new MongoClient(uri);

async function run() {
    try {
        console.log("Attempting direct connection...");
        await client.connect();
        console.log("Connected successfully!");
    } catch (err) {
        console.error("Error:", err.message);
    } finally {
        await client.close();
    }
}

run();
