# These correspond to ESS RStudio mode, rather than RStudio proper
F <- function(x) {
  (misc_value
    |> test()
    |> test2()
    |> test3())
  
  if (TRUE) {
    (x
      |> test())  
  }
}
