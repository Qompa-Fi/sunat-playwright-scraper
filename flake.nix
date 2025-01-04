{
  inputs = {
    nixpkgs.url = "nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
  };

  outputs = inputs:
    with inputs; let
      forEachSystem = nixpkgs.lib.genAttrs (import systems);
    in {
      devShells = forEachSystem (
        system: let
          pkgs = import nixpkgs {
            config = {
              allowUnfree = true;
            };

            inherit system;
          };
        in {
          default = pkgs.mkShell {
            nativeBuildInputs = with pkgs; [
              playwright-driver.browsers
              playwright
              vscode
            ];

            shellHook = ''
              export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
              export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
              export PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH="${pkgs.playwright-driver.browsers}/chromium-1091/chrome-linux/chrome";
            '';
          };
        }
      );
    };
}
