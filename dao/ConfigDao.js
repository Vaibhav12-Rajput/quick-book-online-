const Config = require('../model/Config'); // Import the Config model

class ConfigDao {
    async insert(data, id) {
        const entity = new Config({ ...data, id: id });
        return await entity.save();
    }

    async findAndModify(id, updateData) {
        return await Config.findOneAndUpdate({ _id: id }, updateData, { new: true });
    }

    async findOne(query) {
        return await Config.findOne(query);
    }

    async findAll() {
        return await Config.find({});
    }

    async removeAll() {
        return await Config.deleteMany({});
    }

    async count(query) {
        return await Config.countDocuments(query);
    }

    async findAndRemove(id) {
        return await Config.findOneAndDelete({ _id: id });
    }
}

module.exports = new ConfigDao();
