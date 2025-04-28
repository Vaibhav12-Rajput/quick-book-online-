const Quickbooks = require('../model/Quickbooks');

class QuickbooksDao {
  async insert(data) {
    const entity = new Quickbooks({ ...data, id: require('uuid').v4() });
    return await entity.save();
  }

  async findAndModify(id, updateData) {
    return await Quickbooks.findOneAndUpdate({ _id: id }, updateData, { new: true });
  }

  async findOne(query) {
    return await Quickbooks.findOne(query);
  }

  async findAll() {
    return await Quickbooks.find({});
  }

  async removeAll() {
    return await Quickbooks.deleteMany({});
  }

  async count(query) {
    return await Quickbooks.countDocuments(query);
  }

  async findAndRemove(id) {
    return await Quickbooks.findOneAndDelete({ _id: id });
  }
}

module.exports = new QuickbooksDao();
