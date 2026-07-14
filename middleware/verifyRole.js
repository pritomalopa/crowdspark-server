// Factory that returns role-checking middleware.
// Needs the userCollection so it can look up the requester's role by email.
const verifyRole = (userCollection, allowedRoles = []) => {
  return async (req, res, next) => {
    try {
      const email = req.decoded?.email;
      if (!email) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      const user = await userCollection.findOne({ email });
      if (!user || !allowedRoles.includes(user.role)) {
        return res.status(403).send({ message: "forbidden access" });
      }

      req.userRole = user.role;
      next();
    } catch (err) {
      res.status(500).send({ message: "server error verifying role" });
    }
  };
};

module.exports = verifyRole;
