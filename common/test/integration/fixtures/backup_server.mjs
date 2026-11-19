import readline from "node:readline";

console.log("READY");
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (command) => {
  if (command === "exit") {
    input.close();
    process.stdout.write("COMMAND:exit\n", () => process.exit(0));
    return;
  }
  console.log(`COMMAND:${command}`);
  if (command === "save-all flush") console.log("Saved the game");
});
