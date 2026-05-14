const express = require("express");
const { requireAuth } = require("../auth");
const {
  listDirectMessageConversations,
  listDirectMessageRequestConversations,
  listDirectMessages
} = require("../services/directMessageService");

const router = express.Router();

router.use(requireAuth);

router.get("/", (req, res, next) => {
  try {
    const conversations = listDirectMessageConversations(req.user.id);
    res.json({ conversations });
  } catch (error) {
    next(error);
  }
});

router.get("/requests", (req, res, next) => {
  try {
    const requests = listDirectMessageRequestConversations(req.user.id);
    res.json({ requests });
  } catch (error) {
    next(error);
  }
});

router.get("/:friendId", (req, res, next) => {
  try {
    const friendId = Number(req.params.friendId);
    const result = listDirectMessages(req.user.id, friendId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
